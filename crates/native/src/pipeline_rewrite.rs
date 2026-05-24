//! Post-translation pipeline rewriter — flattens right-leaning `$or`
//! chains and collapses same-field `$eq` disjunctions to `$in`.
//!
//! ## Why this exists
//!
//! mongosql v1.8.5 translates SQL `IN (v1, ..., vN)` and `field = v1 OR
//! field = v2 OR ...` to a pipeline that contains an `$or` array under a
//! deeply-nested `$expr` / `$let` / `$cond` envelope. Local probes against
//! the YAML fixture show v1.8.5 emits a *flat* `$or` array, but the
//! Atlas SQL endpoint emits a **right-leaning chain** of binary `$or`s:
//!
//! ```text
//! { $or: [LEAF, { $or: [LEAF, { $or: [LEAF, …] }] }] }
//! ```
//!
//! With ~100+ values that chain pushes the resulting BSON past MongoDB's
//! maximum nested-object depth (100), and the server rejects the
//! aggregate with:
//!
//! ```text
//! Error code 15 (Overflow): BSONObj exceeds maximum nested object depth
//! ```
//!
//! The verified failure path on a Cube query with 161 `agent_id`
//! values was:
//!
//! ```text
//! pipeline.0.$match.$expr.$let.vars.desugared_sqlAnd_input2.$let.in
//!   .$cond.if.$or.0.$or.0.$or.0…(×97)
//! ```
//!
//! Upstream mongosql issue: tracked for fix in a future mongosql release.
//! Until then this driver applies a pure pipeline rewrite — no SQL parsing,
//! no mongosql changes, no executor-side coupling.
//!
//! ## What the rewriter does
//!
//! Two passes per `$or` location, applied to every `$or` we discover by
//! walking the BSON tree (including inside `$expr` / `$let` / `$cond`):
//!
//! 1. **Flatten.** A right-leaning chain of binary `$or`s is folded into a
//!    single flat array:
//!    `{$or: [A, {$or: [B, {$or: [C, D]}]}]}` becomes
//!    `{$or: [A, B, C, D]}`. Flat arrays don't add nesting per element,
//!    so this alone defeats the BSON-depth cliff.
//!
//! 2. **Collapse to `$in`** (only when safe). If every element of the
//!    flat `$or` is a `$eq` (or `{$eq: ["$field", literal]}`) against the
//!    SAME field with literal scalars, the whole disjunction is rewritten
//!    as `{$in: ["$field", [v1, v2, …]]}`. Order matches the left-to-right
//!    order of the original chain.
//!
//! Collapse is skipped when:
//! - operands reference different fields,
//! - any operand is non-`$eq`,
//! - any value is a field reference / variable / expression (not a literal),
//! - the array is empty.
//!
//! Both rewrites preserve BSON value types byte-for-byte: `Decimal128`,
//! `DateTime`, `ObjectId` operands round-trip without coercion.
//!
//! ## Stack-safety
//!
//! Naive recursion would overflow on the 161-deep chain we see in
//! production. The flattening pass uses an explicit work stack so it
//! is bounded by heap, not the program stack. The outer tree-walk uses
//! safe Rust recursion, which is sound here because rewriting flattens
//! each `$or` at the parent level BEFORE descending — so by the time we
//! recurse, the right-leaning chain has been turned into a flat array,
//! and the recursion only goes one level deep per leaf rather than N.
//! See [`walk_document`].

use bson::{Bson, Document};

/// Public entry-point called from `translate.rs` immediately after
/// `unwrap_pipeline`. Walks every stage and rewrites every `$or` it finds.
///
/// Performance: for queries with no `$or` anywhere in the pipeline this is
/// a linear pass over the BSON nodes with no allocations beyond a single
/// boolean per recursive call.
pub fn flatten_or_chains_and_collapse_to_in(pipeline: &mut [Document]) {
    for stage in pipeline.iter_mut() {
        walk_document(stage);
    }
}

/// Walk a document tree, rewriting every `$or` we encounter.
///
/// ## Stack-safety
///
/// The recursive walk is bounded by the BSON ENVELOPE depth — the
/// `$expr.$let.in.$cond` wrapping mongosql applies. In practice this is
/// at most a handful of levels (≤ ~10 in the verified failure trace,
/// invariant of N). It is NOT bounded by the `$or` chain depth, because
/// we rewrite `$or` at each document BEFORE recursing into its children:
/// after [`rewrite_or_in_place`] flattens a right-leaning chain, the
/// children are all siblings at the same flat level, so the subsequent
/// recursion only goes one level deep per leaf — no stack growth
/// proportional to N. This is why we can use safe Rust recursion here
/// without overflowing on the 165-deep production chain (covered by
/// `flatten_handles_165_deep_chain_without_stack_overflow`).
fn walk_document(doc: &mut Document) {
    // Flatten / collapse any `$or` at THIS level first. If `doc` is a
    // `{$or: [...]}` wrapper, flattening turns the right-leaning chain
    // into a flat array so the subsequent descent visits each leaf at
    // depth 1, not depth N.
    if doc.contains_key("$or") {
        rewrite_or_in_place(doc);
    }
    // Now descend.
    for (_, v) in doc.iter_mut() {
        walk_bson(v);
    }
}

fn walk_bson(b: &mut Bson) {
    match b {
        Bson::Document(d) => walk_document(d),
        Bson::Array(a) => {
            for v in a.iter_mut() {
                walk_bson(v);
            }
        }
        _ => {}
    }
}

/// Apply both rewrites to a `$or` operand of the given document.
///
/// Caller has already verified `doc.contains_key("$or")`. After this
/// returns, the document either:
/// - still has a `$or` key whose value is a flat `Bson::Array` of
///   non-`$or` elements, or
/// - had its `$or` key removed and a `$in` key added in its place
///   (when the collapse precondition held).
fn rewrite_or_in_place(doc: &mut Document) {
    // Take ownership of the `$or` value so we can rebuild it. We always
    // re-insert (either as a flattened `$or` or as a `$in`) before
    // returning.
    let or_val = match doc.remove("$or") {
        Some(v) => v,
        None => return,
    };

    let mut elements = match or_val {
        Bson::Array(a) => a,
        other => {
            // Preserve unknown shape rather than dropping it. mongosql
            // always emits `Bson::Array` here so this branch is defensive.
            doc.insert("$or", other);
            return;
        }
    };

    // PASS 1: flatten right-leaning (and left-leaning, for that matter)
    // nested `$or` arrays into a single flat list. Stack-bounded loop:
    // we splice nested arrays in place, then re-scan. Worst-case O(N)
    // splices on an N-deep chain because each splice removes one nested
    // wrapper. Heap, not program stack.
    elements = flatten_or_array(elements);

    // PASS 2: try to collapse to `$in` if every element is a same-field
    // `$eq` against a literal scalar.
    if let Some((field, values)) = try_collect_same_field_eq(&elements) {
        doc.insert(
            "$in",
            Bson::Array(vec![Bson::String(field), Bson::Array(values)]),
        );
        return;
    }

    // Re-insert the (now flat) `$or` array.
    doc.insert("$or", Bson::Array(elements));
}

/// Iteratively flatten a `$or` array: any element that is itself a
/// `{$or: [...]}` document has its inner array spliced into the parent.
///
/// Stack-safe: works against an N-deep right-leaning chain (or any tree
/// shape) without recursing. Uses an explicit work queue.
fn flatten_or_array(elements: Vec<Bson>) -> Vec<Bson> {
    let mut out: Vec<Bson> = Vec::with_capacity(elements.len());
    // Work queue holds elements left to inspect. Push in reverse so that
    // the final `out` preserves the original left-to-right order
    // (critical for the `$in` order-preservation property).
    let mut work: Vec<Bson> = Vec::with_capacity(elements.len());
    for e in elements.into_iter().rev() {
        work.push(e);
    }
    while let Some(elem) = work.pop() {
        match elem {
            Bson::Document(mut d) => {
                // If this is a `{$or: [...]}` wrapper with NOTHING else,
                // splice its array. We allow a single-key `{$or: ...}`
                // document — if the wrapper carries siblings (it shouldn't
                // in well-formed MQL but be defensive) we keep it whole.
                let is_pure_or_wrapper =
                    d.len() == 1 && matches!(d.get("$or"), Some(Bson::Array(_)));
                if is_pure_or_wrapper {
                    if let Some(Bson::Array(inner)) = d.remove("$or") {
                        for e in inner.into_iter().rev() {
                            work.push(e);
                        }
                        continue;
                    }
                }
                out.push(Bson::Document(d));
            }
            other => out.push(other),
        }
    }
    out
}

/// If every element of `elements` is a same-field `$eq` against a literal
/// scalar, return `(field_ref, values)` where `field_ref` is the
/// `$<field>` operand and `values` are the literal RHS values in
/// original left-to-right order.
///
/// Returns `None` if:
/// - `elements` is empty,
/// - any element isn't a `Bson::Document` with a single `$eq` key,
/// - the `$eq` operand isn't a 2-element array `[<field_ref>, <literal>]`,
/// - the field ref doesn't start with `$` (i.e. isn't a field reference),
/// - the field refs across operands don't match,
/// - the RHS contains a non-literal expression (anything starting with
///   `$` that isn't wrapped in `$literal`).
///
/// `$literal: x` is unwrapped — the inner `x` is what lands in the
/// resulting `$in` array. Bare BSON literals (Bson::String,
/// Bson::Int64, Bson::Decimal128, Bson::DateTime, Bson::ObjectId, etc.)
/// are accepted as-is.
fn try_collect_same_field_eq(elements: &[Bson]) -> Option<(String, Vec<Bson>)> {
    if elements.is_empty() {
        return None;
    }

    let mut field_ref: Option<String> = None;
    let mut values: Vec<Bson> = Vec::with_capacity(elements.len());

    for elem in elements {
        let doc = match elem {
            Bson::Document(d) => d,
            _ => return None,
        };
        // We accept the `$expr`-style operator form `{$eq: [a, b]}`
        // exclusively. The `$match`-style query operator form
        // `{<field>: {$eq: <lit>}}` would have a non-`$`-prefixed
        // top-level key; we don't collapse those because the
        // collapse-target `$in` is also operator-form and would change
        // the semantics in an unsafe way.
        if doc.len() != 1 {
            return None;
        }
        let (k, v) = doc.iter().next()?;
        if k != "$eq" {
            return None;
        }
        let arr = match v {
            Bson::Array(a) => a,
            _ => return None,
        };
        if arr.len() != 2 {
            return None;
        }
        // LHS must be a field reference string (Bson::String starting
        // with `$`). mongosql also wraps these as `{$let.vars.<var>:
        // "$field"}` and then uses `$$<var>` inside; we conservatively
        // only collapse the bare-`$field` case because the `$in`
        // semantics on `$$var` would require the same binding to be in
        // scope — which it always is, but verifying that is more
        // structural work than we want to bite off here.
        let lhs_ref = match &arr[0] {
            Bson::String(s) if s.starts_with('$') && !s.starts_with("$$") => s.clone(),
            _ => return None,
        };
        match &field_ref {
            None => field_ref = Some(lhs_ref),
            Some(prev) if *prev == lhs_ref => {}
            Some(_) => return None,
        }

        // RHS must be a literal. Accept either bare BSON literal scalars
        // or `{$literal: <x>}` wrappers (mongosql's preferred form). A
        // non-literal expression (any document with $-prefixed keys
        // other than $literal, or a field-ref string) means we can't
        // collapse.
        let lit = extract_literal(&arr[1])?;
        values.push(lit);
    }

    field_ref.map(|f| (f, values))
}

/// Try to extract a literal value from a `$eq` RHS. Returns:
/// - `Some(x)` if `b` is a bare BSON literal (String, Int32, Int64,
///   Double, Decimal128, DateTime, ObjectId, Boolean, Null, Binary,
///   Symbol), or `{$literal: x}`.
/// - `None` if `b` is a field reference (`Bson::String` starting with
///   `$`), or a document with any other $-prefixed key (which would be
///   an expression, not a literal), or an Array (we don't collapse
///   nested-array $eq operands).
fn extract_literal(b: &Bson) -> Option<Bson> {
    match b {
        // `{$literal: x}` is the safe form — accept any inner value.
        Bson::Document(d) if d.len() == 1 => {
            if let Some(v) = d.get("$literal") {
                return Some(v.clone());
            }
            // Single-key document that isn't $literal — could be an
            // expression like `{$let: ...}` or `{$abs: ...}`. Reject.
            None
        }
        // A document with more keys could still be a literal sub-document
        // (a regular embedded doc with no $-prefixed keys). Accept if NO
        // key starts with `$`. mongosql `$eq` RHS values are always
        // `$literal`-wrapped in the IN/OR shapes we care about, so this
        // branch is defensive and rare.
        Bson::Document(d) => {
            if d.keys().any(|k| k.starts_with('$')) {
                None
            } else {
                Some(Bson::Document(d.clone()))
            }
        }
        // Strings starting with `$` are field references / variables —
        // NOT literals.
        Bson::String(s) if s.starts_with('$') => None,
        // Arrays are not literals in our collapse-precondition (we don't
        // want to confuse `[a, b]` with a 2-tuple `$eq` operand).
        Bson::Array(_) => None,
        // Everything else (scalar literals including Decimal128, DateTime,
        // ObjectId, Boolean, Null, Int32, Int64, Double, String without
        // leading `$`) is accepted as-is, preserving its BSON type.
        other => Some(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{bson, doc, oid::ObjectId, DateTime, Decimal128, Document};

    /// Helper: build a right-leaning `$or` chain of N `$eq` leaves on
    /// the same field. Used by the deep-chain stack-overflow test.
    fn build_right_leaning_or_chain(field: &str, values: &[i64]) -> Document {
        assert!(values.len() >= 2);
        // Inner-most pair becomes the deepest `$or`.
        let last_two = values.len() - 2;
        let mut current = doc! {
            "$or": [
                doc! {"$eq": [format!("${field}"), values[last_two]]},
                doc! {"$eq": [format!("${field}"), values[last_two + 1]]},
            ],
        };
        // Wrap with successive `$or`s going outward.
        for i in (0..last_two).rev() {
            let leaf = doc! {"$eq": [format!("${field}"), values[i]]};
            current = doc! {
                "$or": [Bson::Document(leaf), Bson::Document(current)],
            };
        }
        current
    }

    /// Helper: pull out the `$or` array from a doc; panic on shape mismatch.
    fn or_array(d: &Document) -> &Vec<Bson> {
        match d.get("$or") {
            Some(Bson::Array(a)) => a,
            other => panic!("expected $or array, got {other:?}"),
        }
    }

    // ----- flatten -----

    #[test]
    fn flatten_nested_or_collapses_to_flat_array() {
        // {$or: [A, {$or: [B, {$or: [C, D]}]}]} → {$or: [A, B, C, D]}
        let a = doc! {"a": 1};
        let b = doc! {"b": 2};
        let c = doc! {"c": 3};
        let d = doc! {"d": 4};
        let mut input = doc! {
            "$or": [
                Bson::Document(a.clone()),
                Bson::Document(doc! {
                    "$or": [
                        Bson::Document(b.clone()),
                        Bson::Document(doc! {
                            "$or": [Bson::Document(c.clone()), Bson::Document(d.clone())],
                        }),
                    ],
                }),
            ],
        };
        rewrite_or_in_place(&mut input);
        let arr = or_array(&input);
        assert_eq!(arr.len(), 4, "expected 4 flat leaves, got {arr:?}");
        // Order preserved left-to-right
        assert_eq!(arr[0], Bson::Document(a));
        assert_eq!(arr[1], Bson::Document(b));
        assert_eq!(arr[2], Bson::Document(c));
        assert_eq!(arr[3], Bson::Document(d));
    }

    #[test]
    fn flatten_handles_165_deep_chain_without_stack_overflow() {
        // The real-world failure shape: a 165-deep right-leaning chain
        // of `$eq` leaves. Naive recursion would overflow the program
        // stack; the iterative work-stack must terminate.
        let values: Vec<i64> = (0..165).collect();
        let input_doc = build_right_leaning_or_chain("x", &values);
        // Place it inside a pipeline stage so the walker gets to it.
        let mut pipeline = vec![doc! {
            "$match": { "$expr": Bson::Document(input_doc) }
        }];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        // The rewriter should produce a `$in` (same-field $eq leaves on
        // an int field) — but if it produces a flat `$or` that's also a
        // valid intermediate. Assert one of those two shapes.
        let stage = &pipeline[0];
        let expr = stage.get_document("$match").unwrap().get("$expr").unwrap();
        let expr_doc = expr.as_document().expect("expr document");
        if let Some(Bson::Array(in_args)) = expr_doc.get("$in") {
            assert_eq!(in_args.len(), 2);
            assert_eq!(in_args[0], Bson::String("$x".to_string()));
            let vals = in_args[1].as_array().expect("values array");
            assert_eq!(vals.len(), 165, "all 165 leaves preserved in $in");
            // Order preserved.
            for (i, v) in vals.iter().enumerate() {
                assert_eq!(v.as_i64(), Some(i as i64), "value {i} preserved in order");
            }
        } else if let Some(Bson::Array(or_arr)) = expr_doc.get("$or") {
            assert_eq!(or_arr.len(), 165, "all 165 leaves in flat $or");
        } else {
            panic!("expected $in or flat $or; got {expr_doc:?}");
        }
    }

    #[test]
    fn already_flat_or_passes_through_or_collapses() {
        // {$or: [{$eq: ["$x", 1]}, {$eq: ["$x", 2]}]} — should collapse.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {"$eq": ["$x", 2_i64]},
            ],
        };
        rewrite_or_in_place(&mut input);
        let in_args = input.get_array("$in").expect("collapsed to $in");
        assert_eq!(in_args.len(), 2);
        assert_eq!(in_args[0], Bson::String("$x".to_string()));
        let vals = in_args[1].as_array().expect("values array");
        assert_eq!(vals[0].as_i64(), Some(1));
        assert_eq!(vals[1].as_i64(), Some(2));
    }

    // ----- collapse: positive -----

    #[test]
    fn collapse_same_field_eq_chain_to_in() {
        // {$or: [{$eq:["$x",1]},{$eq:["$x",2]},{$eq:["$x",3]}]} → {$in:["$x",[1,2,3]]}
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {"$eq": ["$x", 2_i64]},
                doc! {"$eq": ["$x", 3_i64]},
            ],
        };
        rewrite_or_in_place(&mut input);
        assert!(!input.contains_key("$or"), "$or should be replaced");
        let in_args = input.get_array("$in").expect("$in array");
        assert_eq!(in_args.len(), 2);
        assert_eq!(in_args[0], Bson::String("$x".to_string()));
        let vals = in_args[1].as_array().expect("values");
        assert_eq!(vals.len(), 3);
        assert_eq!(vals[0].as_i64(), Some(1));
        assert_eq!(vals[1].as_i64(), Some(2));
        assert_eq!(vals[2].as_i64(), Some(3));
    }

    #[test]
    fn collapse_accepts_dollar_literal_wrapped_values() {
        // mongosql's preferred RHS form is `{$literal: x}`. Must unwrap.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", { "$literal": "a" }]},
                doc! {"$eq": ["$x", { "$literal": "b" }]},
            ],
        };
        rewrite_or_in_place(&mut input);
        let in_args = input.get_array("$in").expect("$in");
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals[0].as_str(), Some("a"));
        assert_eq!(vals[1].as_str(), Some("b"));
    }

    #[test]
    fn collapse_preserves_decimal128_datetime_objectid() {
        // BSON value-type fidelity: high-precision types survive the
        // collapse unchanged. Each leaf uses a different type — the
        // collapse rejects mixed types only if the precondition rejects
        // them; this test pins that scalar literal types are accepted
        // and round-trip byte-identically.
        let dec: Decimal128 = "123.456".parse().expect("decimal");
        let dt = DateTime::from_millis(1_700_000_000_000);
        let oid = ObjectId::new();
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", { "$literal": dec }]},
                doc! {"$eq": ["$x", { "$literal": Bson::DateTime(dt) }]},
                doc! {"$eq": ["$x", { "$literal": Bson::ObjectId(oid) }]},
            ],
        };
        rewrite_or_in_place(&mut input);
        let in_args = input.get_array("$in").expect("$in");
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals.len(), 3);
        assert_eq!(vals[0], Bson::Decimal128(dec));
        assert_eq!(vals[1], Bson::DateTime(dt));
        assert_eq!(vals[2], Bson::ObjectId(oid));
    }

    // ----- collapse: negative -----

    #[test]
    fn collapse_skipped_for_different_fields() {
        // {$or: [{$eq:["$x",1]},{$eq:["$y",2]}]} stays as flat $or.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {"$eq": ["$y", 2_i64]},
            ],
        };
        rewrite_or_in_place(&mut input);
        assert!(input.contains_key("$or"), "must remain a $or");
        assert!(!input.contains_key("$in"), "must NOT collapse");
        assert_eq!(or_array(&input).len(), 2);
    }

    #[test]
    fn collapse_skipped_for_non_eq_leaf() {
        // {$or: [{$eq:["$x",1]},{$gt:["$x",2]}]} stays as flat $or.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {"$gt": ["$x", 2_i64]},
            ],
        };
        rewrite_or_in_place(&mut input);
        assert!(input.contains_key("$or"));
        assert!(!input.contains_key("$in"));
    }

    #[test]
    fn collapse_skipped_for_non_literal_value() {
        // RHS is a field ref, not a literal.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", "$y"]},
                doc! {"$eq": ["$x", "$z"]},
            ],
        };
        rewrite_or_in_place(&mut input);
        assert!(input.contains_key("$or"));
        assert!(!input.contains_key("$in"));
    }

    #[test]
    fn collapse_skipped_for_variable_lhs() {
        // mongosql's let-bound variables look like `$$desugared_sqlEq_input0`.
        // We DON'T collapse those because reasoning about variable scopes
        // is out of scope for a pipeline-shape rewrite.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$$desugared_sqlOr_input0", 1_i64]},
                doc! {"$eq": ["$$desugared_sqlOr_input1", 2_i64]},
            ],
        };
        rewrite_or_in_place(&mut input);
        assert!(input.contains_key("$or"));
        assert!(!input.contains_key("$in"));
    }

    #[test]
    fn collapse_skipped_for_expression_value() {
        // RHS is a sub-expression like `{$abs: ...}` — not a literal.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", doc! {"$abs": -1_i64}]},
                doc! {"$eq": ["$x", doc! {"$abs": -2_i64}]},
            ],
        };
        rewrite_or_in_place(&mut input);
        assert!(input.contains_key("$or"));
        assert!(!input.contains_key("$in"));
    }

    // ----- walker -----

    #[test]
    fn nested_inside_expr_let_cond() {
        // The exact real-world shape: $or buried inside $expr.$let.in.$cond.
        // The walker must recurse into all of those.
        let values: Vec<i64> = (0..5).collect();
        let or_chain = build_right_leaning_or_chain("x", &values);
        let mut pipeline = vec![doc! {
            "$match": {
                "$expr": {
                    "$let": {
                        "vars": { "tmp": "$some_field" },
                        "in": {
                            "$cond": {
                                "if": Bson::Document(or_chain),
                                "then": { "$literal": true },
                                "else": { "$literal": false },
                            },
                        },
                    },
                },
            },
        }];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let inner = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get_document("$expr")
            .unwrap()
            .get_document("$let")
            .unwrap()
            .get_document("in")
            .unwrap()
            .get_document("$cond")
            .unwrap()
            .get("if")
            .unwrap();
        let inner_doc = inner.as_document().expect("if branch is a document");
        // Should have collapsed to $in (same-field eq leaves with int literals).
        let in_args = inner_doc.get_array("$in").expect("collapsed");
        assert_eq!(in_args[0], Bson::String("$x".to_string()));
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals.len(), 5);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_i64(), Some(i as i64));
        }
    }

    #[test]
    fn walker_handles_arrays_of_documents() {
        // Pipeline stage with a nested array containing $or-bearing docs.
        let or_chain = build_right_leaning_or_chain("x", &[1, 2, 3, 4]);
        let mut pipeline = vec![doc! {
            "$facet": {
                "branch1": [
                    { "$match": { "$expr": Bson::Document(or_chain) } },
                ],
            },
        }];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let branch = pipeline[0]
            .get_document("$facet")
            .unwrap()
            .get_array("branch1")
            .unwrap();
        let match_stage = branch[0].as_document().unwrap();
        let expr = match_stage
            .get_document("$match")
            .unwrap()
            .get("$expr")
            .unwrap()
            .as_document()
            .unwrap();
        // Should collapse to $in.
        assert!(expr.contains_key("$in"), "got {expr:?}");
    }

    #[test]
    fn no_op_on_pipelines_with_no_or() {
        let mut pipeline = vec![
            doc! {"$match": {"status": "paid"}},
            doc! {"$group": {"_id": "$account_id", "n": {"$sum": 1_i64}}},
            doc! {"$sort": {"n": -1_i32}},
            doc! {"$limit": 100_i64},
        ];
        let snapshot = pipeline.clone();
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        assert_eq!(pipeline, snapshot, "must be byte-identical");
    }

    #[test]
    fn mixed_or_chains_in_same_pipeline() {
        // Multiple stages each with their own $or chains — each must be
        // rewritten independently.
        let chain_a = build_right_leaning_or_chain("a", &[1, 2, 3]);
        let chain_b = build_right_leaning_or_chain("b", &[10, 20, 30, 40]);
        let mut pipeline = vec![
            doc! {"$match": {"$expr": Bson::Document(chain_a)}},
            doc! {"$match": {"$expr": Bson::Document(chain_b)}},
        ];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let inner_a = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get("$expr")
            .unwrap()
            .as_document()
            .unwrap();
        let inner_b = pipeline[1]
            .get_document("$match")
            .unwrap()
            .get("$expr")
            .unwrap()
            .as_document()
            .unwrap();
        let in_a = inner_a.get_array("$in").expect("a collapsed");
        let in_b = inner_b.get_array("$in").expect("b collapsed");
        assert_eq!(in_a[0], Bson::String("$a".to_string()));
        assert_eq!(in_b[0], Bson::String("$b".to_string()));
        assert_eq!(in_a[1].as_array().unwrap().len(), 3);
        assert_eq!(in_b[1].as_array().unwrap().len(), 4);
    }

    #[test]
    fn order_preserved_after_flatten_and_collapse() {
        // Pin the order-preservation guarantee on a deeper chain so a
        // future refactor doesn't silently reverse it.
        let values: Vec<i64> = vec![7, 13, 19, 23, 31, 37];
        let chain = build_right_leaning_or_chain("x", &values);
        let mut wrapper = doc! {
            "$match": {"$expr": Bson::Document(chain)},
        };
        let mut pipeline = vec![std::mem::take(&mut wrapper)];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let in_args = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get("$expr")
            .unwrap()
            .as_document()
            .unwrap()
            .get_array("$in")
            .unwrap();
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals.len(), values.len());
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_i64(), Some(values[i]));
        }
    }

    #[test]
    fn empty_or_left_untouched() {
        // Defensive: `{$or: []}` shouldn't appear in well-formed MQL but
        // if it does, the rewriter must not crash and must not collapse
        // (try_collect_same_field_eq returns None on empty input).
        let mut input = doc! {"$or": []};
        rewrite_or_in_place(&mut input);
        // Empty $or stays as empty $or.
        assert!(input.contains_key("$or"));
        let arr = or_array(&input);
        assert!(arr.is_empty());
    }

    #[test]
    fn left_leaning_chain_also_flattens() {
        // Symmetric to right-leaning: `{$or:[{$or:[{$or:[A,B]},C]},D]}`
        // must also flatten. The implementation is shape-agnostic; this
        // test pins it explicitly.
        let leaves: Vec<Bson> = (0..6).map(|i| bson!({"$eq": ["$x", i as i64]})).collect();
        // Build left-leaning: ((((L0 ∨ L1) ∨ L2) ∨ L3) ∨ L4) ∨ L5
        let mut current = bson!({"$or": [leaves[0].clone(), leaves[1].clone()]});
        for leaf in leaves.iter().skip(2) {
            current = bson!({"$or": [current, leaf.clone()]});
        }
        let mut wrapper = doc! {"value": current};
        // Get a &mut Document around the $or so rewrite_or_in_place can run.
        // The walker handles arbitrary nesting — drive it through the
        // public entry point instead.
        let mut pipeline = vec![doc! {"$match": {"$expr": wrapper.remove("value").unwrap()}}];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let expr = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get("$expr")
            .unwrap()
            .as_document()
            .unwrap();
        let in_args = expr.get_array("$in").expect("collapsed");
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals.len(), 6);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_i64(), Some(i as i64));
        }
    }
}

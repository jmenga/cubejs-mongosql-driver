//! Post-translation pipeline rewriter — flattens nested `$or` / `$and`
//! chains and collapses same-field `$eq` / `$ne` disjunctions to
//! `$in` / `$nin`.
//!
//! ## Why this exists
//!
//! Real failure mode (verified empirically against the Atlas SQL endpoint
//! `*.a.query.mongodb.net`):
//!
//! 1. `mongosql::translate_sql` v1.8.5 outputs a **flat** `$or` array for
//!    SQL `IN (v1, …, vN)` and a **flat** `$and` array for `NOT IN`
//!    (depth 1, irrespective of N). This is confirmed against both the
//!    local YAML fixture catalog and against a real Atlas SQL endpoint's
//!    `sqlGetSchema`-derived catalog (see `crates/native/tests/critic_probe.rs`).
//! 2. When the driver sends that flat pipeline over the wire to an
//!    **Atlas SQL endpoint** (`*.a.query.mongodb.net`), the proxy /
//!    server-side query layer **re-expands** the flat array into a
//!    right-leaning chain of binary `$or` / `$and`s before passing the
//!    aggregate to the underlying MongoDB query engine:
//!
//!    ```text
//!    { $or: [LEAF, { $or: [LEAF, { $or: [LEAF, …] }] }] }
//!    ```
//!
//! 3. For N ≥ ~100 that chain pushes the materialised BSON past
//!    MongoDB's maximum nested-object depth (100), and the server
//!    rejects the aggregate with:
//!
//!    ```text
//!    Error code 15 (Overflow): BSONObj exceeds maximum nested object depth
//!    ```
//!
//! 4. Collapsing the same-field `$eq` disjunction to `$in` (and
//!    same-field `$ne` conjunction to `$nin`) **defeats the
//!    re-expansion**: there is no n-ary boolean array left for the proxy
//!    to chain-ify. The flatten pass alone is not sufficient against a
//!    re-expanding proxy — verified by reverting just the collapse and
//!    re-sending a 200-element flat `$or`: the server still rejects with
//!    the same overflow error, the chain visible in
//!    `pipeline.0.$match.$expr.$or.0.$or.0.$or.0…`. Verified
//!    independently for `$and` re-expansion with a 200-value `NOT IN`
//!    against the real Atlas SQL endpoint (same Error 15, chain visible
//!    in `pipeline.0.$match.$expr.$and.0.$and.0.$and.0…`).
//!
//! The verified failure-path field name on a Cube query with 161
//! `agent_id` values was:
//!
//! ```text
//! pipeline.0.$match.$expr.$let.vars.desugared_sqlAnd_input2.$let.in
//!   .$cond.if.$or.0.$or.0.$or.0…(×97)
//! ```
//!
//! Note this is the **server's** error path — the path before the wire
//! send is flat. The flatten pass is kept (defensive: cheap to run, and
//! defends against any future translator that emits the chain
//! client-side; the existing `mongosql` v1.8.5 is the one we ship with).
//!
//! ## What the rewriter does
//!
//! Two parallel passes per `$or` / `$and` location, applied to every
//! match we discover by walking the BSON tree (including inside
//! `$expr` / `$let` / `$cond`):
//!
//! 1. **Flatten.** A nested chain of binary boolean wrappers is folded
//!    into a single flat array:
//!    `{$or: [A, {$or: [B, {$or: [C, D]}]}]}` becomes
//!    `{$or: [A, B, C, D]}`. Flat arrays don't add nesting per element,
//!    so this alone defeats a client-side BSON-depth cliff.
//!
//! 2. **Collapse** (only when safe):
//!    - **`$or` → `$in`.** If every element of the flat `$or` is a
//!      `{$eq: ["$field", literal]}` against the SAME field with
//!      literal scalars, the whole disjunction is rewritten as
//!      `{$in: ["$field", [v1, v2, …]]}`. Order matches the
//!      left-to-right order of the original chain.
//!    - **`$and` → `{$not: {$in: …}}`.** Symmetric for `NOT IN`: a
//!      flat `$and` of `{$ne: ["$field", literal]}` becomes
//!      `{$not: {$in: ["$field", [v1, …]]}}`. NOTE: we deliberately do
//!      NOT emit `{$nin: [...]}` here. `$nin` is a MongoDB *query*
//!      operator, valid only in `$match.<field>: {$nin: [...]}` form;
//!      it is NOT an aggregation expression operator. Inside `$expr`
//!      (where mongosql lands its NOT IN), the server rejects `$nin`
//!      with `code 168: Unrecognized expression '$nin'`. The
//!      expression-context spelling is `{$not: {$in: [...]}}`,
//!      verified empirically against atlas-local.
//!
//! Collapse is skipped when:
//! - operands reference different fields,
//! - any operand is non-`$eq` / non-`$ne`,
//! - any value is a field reference / variable / expression (not a literal),
//! - the array is empty.
//!
//! Both rewrites preserve BSON value types byte-for-byte: `Decimal128`,
//! `DateTime`, `ObjectId` operands round-trip without coercion.
//!
//! ## `$literal` preservation
//!
//! mongosql wraps RHS literals in `{$literal: x}`. We unwrap them when
//! the inner value is "obviously safe" (a non-`$`-prefixed string, or any
//! non-document scalar), but for two cases we **preserve the wrapper**:
//!
//! - inner value is a `Bson::String` starting with `$` (could be
//!   evaluated as a field reference inside `$in` / `$nin`),
//! - inner value is a `Bson::Document` containing any `$`-prefixed key
//!   (could be evaluated as an operator expression).
//!
//! Both `$in` and `$nin` evaluate `{$literal: x}` to `x` inside their
//! value arrays, so preserving the wrapper is semantically equivalent to
//! unwrapping AND safe even when the inner value would otherwise be
//! treated as an expression. The pre-fix bug (unwrapping
//! `{$literal: "$evil_field"}` to a bare `"$evil_field"`) would have
//! turned a literal `'$evil_field'` SQL value into a field reference
//! after the collapse.
//!
//! ## Stack-safety
//!
//! Stack-safety comes from the iterative work-stack inside
//! [`flatten_bool_array`]; the outer walker's recursion depth is bounded
//! by BSON envelope depth (typically ≤ 10, invariant of N — the
//! verified failure trace had ~10 envelope levels for any IN-list
//! size), independent of the `$or` / `$and` chain length N. Even if the
//! walker recursed without flattening first, the iterative
//! [`flatten_bool_array`] would still defend against stack overflow at
//! the leaf level. The pre-flatten ordering in `walk_document` is a
//! micro-optimisation (avoids re-traversing the now-flattened array's
//! elements as separate boolean wrappers) but is NOT load-bearing for
//! stack safety.

use bson::{Bson, Document};

/// Public entry-point called from `translate.rs` immediately after
/// `unwrap_pipeline`. Walks every stage and rewrites every `$or` /
/// `$and` it finds.
///
/// Performance: for queries with no boolean disjunction/conjunction
/// anywhere in the pipeline this is a linear pass over the BSON nodes
/// with no allocations beyond a single boolean per recursive call.
pub fn flatten_or_chains_and_collapse_to_in(pipeline: &mut [Document]) {
    for stage in pipeline.iter_mut() {
        walk_document(stage);
    }
}

/// Walk a document tree, rewriting every `$or` / `$and` we encounter.
///
/// ## Stack-safety
///
/// The recursive walk is bounded by the BSON ENVELOPE depth — the
/// `$expr.$let.in.$cond` wrapping mongosql applies. In practice this is
/// at most a handful of levels (≤ ~10 in the verified failure trace,
/// invariant of N).
///
/// Stack-safety against an N-deep chain comes from the iterative
/// work-stack inside [`flatten_bool_array`]. Even if this walker
/// recursed without pre-flattening, that iterative helper would still
/// defend against stack overflow at the leaf level. The pre-flatten
/// ordering here is a micro-optimisation (and a documentation hook): by
/// the time we descend into the (now flat) array, all leaves are
/// siblings at the same depth, so the subsequent recursion only goes
/// one level deep per leaf rather than re-walking N nested
/// `{$or: [...]}` wrappers.
fn walk_document(doc: &mut Document) {
    // Flatten / collapse any `$or` / `$and` at THIS level first.
    if doc.contains_key("$or") {
        rewrite_bool_in_place(doc, BoolOp::Or);
    }
    if doc.contains_key("$and") {
        rewrite_bool_in_place(doc, BoolOp::And);
    }

    // Skip descent into `$in` / `$nin` value arrays. Those are pure
    // value lists (after our own collapse, or whatever mongosql emits
    // directly), and they cannot contain `$or` / `$and` operator
    // expressions — descending into them is wasted work for large IN
    // lists. We keep the recursion for every other key.
    //
    // Why ONLY `$in` / `$nin` and not other array-taking aggregation
    // operators? Per the MongoDB Aggregation Pipeline Operators
    // reference (https://www.mongodb.com/docs/manual/reference/operator/aggregation/),
    // every other array-taking operator's elements are EXPRESSIONS, not
    // value-only lists: `$concat` / `$concatArrays` take expression
    // arguments; `$arrayElemAt` takes an `<array expression>` that can
    // nest further; `$range` takes `<start>, <end>, <step>` expression
    // ints; `$setUnion` / `$setIntersection` / `$setDifference` /
    // `$setEquals` / `$setIsSubset` take set-expression arguments; etc.
    // In each of those cases a `$or` / `$and` CAN legally appear in the
    // sub-expression (e.g. `{$concatArrays: [["a"], {$cond: [{$or:
    // [...]}, [...], [...]]}}]}`), so descending is required. The
    // `$in` / `$nin` aggregation-expression operators are special: the
    // second positional argument is documented as a value array whose
    // elements are evaluated as values, not as operator expressions, so
    // it cannot contain a `$or` / `$and` we'd want to rewrite. The
    // `walker_does_not_descend_into_{in,nin}_value_array` tests pin this.
    for (k, v) in doc.iter_mut() {
        if k == "$in" || k == "$nin" {
            continue;
        }
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

/// Boolean operator we're flattening/collapsing — `$or` or `$and`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoolOp {
    Or,
    And,
}

impl BoolOp {
    /// The MQL operator name (`"$or"` / `"$and"`).
    fn key(self) -> &'static str {
        match self {
            BoolOp::Or => "$or",
            BoolOp::And => "$and",
        }
    }

    /// The leaf operator we collapse against (`"$eq"` for `$or`,
    /// `"$ne"` for `$and`). Same-field same-leaf chains collapse to the
    /// corresponding set operator.
    fn leaf_op(self) -> &'static str {
        match self {
            BoolOp::Or => "$eq",
            BoolOp::And => "$ne",
        }
    }
}

/// Apply both rewrites to a `$or` / `$and` operand of the given document.
///
/// Caller has already verified `doc.contains_key(op.key())`. After this
/// returns, the document either:
/// - still has the boolean key whose value is a flat `Bson::Array` of
///   non-`<op>` elements, or
/// - had the boolean key removed and the corresponding set-op key
///   (`$in` / `$nin`) added in its place (when the collapse
///   precondition held).
fn rewrite_bool_in_place(doc: &mut Document, op: BoolOp) {
    // Take ownership of the operator value so we can rebuild it. We
    // always re-insert (either as a flattened operator array or as the
    // collapsed set-op) before returning.
    //
    // MINOR-3: `doc.remove` + later `doc.insert` is `IndexMap`-backed,
    // so a non-Array operand follows the defensive non-Array branch
    // below and gets re-inserted at the END of the doc rather than at
    // its original position. mongosql never emits a non-Array `$or` /
    // `$and` operand, so this branch is defensive-only; the resulting
    // key reorder is acceptable for that case. The common Array path
    // never trips this — when we re-insert under `op.key()` IndexMap
    // updates the existing slot in place since it was removed-then-
    // re-inserted within the same call but BEFORE iteration resumes.
    let val = match doc.remove(op.key()) {
        Some(v) => v,
        None => return,
    };

    let mut elements = match val {
        Bson::Array(a) => a,
        other => {
            // Preserve unknown shape rather than dropping it. mongosql
            // always emits `Bson::Array` here so this branch is defensive.
            doc.insert(op.key(), other);
            return;
        }
    };

    // PASS 1: flatten nested boolean arrays into a single flat list.
    // Stack-bounded loop: we splice nested arrays in place, then
    // re-scan. Worst-case O(N) splices on an N-deep chain because each
    // splice removes one nested wrapper. Heap, not program stack.
    elements = flatten_bool_array(elements, op);

    // PASS 2: try to collapse to a set-op if every element is a
    // same-field same-leaf-op against a literal scalar.
    if let Some((field, values)) = try_collect_same_field_leaf(&elements, op.leaf_op()) {
        let in_expr = Bson::Array(vec![Bson::String(field), Bson::Array(values)]);
        match op {
            BoolOp::Or => {
                // `$or` of same-field `$eq` → `{$in: ["$field", [...]]}`.
                //
                // MINOR-6: defensive collision check. mongosql v1.8.5
                // never emits a sibling `$in` alongside a `$or` in the
                // same doc (the Atlas SQL proxy re-expansion goes the
                // other direction: `$in` is split, not added next to a
                // `$or`), so this collision is impossible in practice —
                // see the comment block above `rewrite_bool_in_place`
                // and the `or_with_sibling_in_does_not_overwrite` test
                // that pins the post-conservative behaviour. The
                // assertion documents the invariant and traps any future
                // mongosql release that breaks it during development /
                // test builds.
                debug_assert!(
                    !doc.contains_key("$in"),
                    "BUG: $or-collapse would overwrite sibling $in in same document; \
                     mongosql never emits this shape — see MINOR-6 in pipeline_rewrite.rs",
                );
                doc.insert("$in", in_expr);
            }
            BoolOp::And => {
                // `$and` of same-field `$ne` → `{$not: {$in: [...]}}`.
                //
                // CRITICAL: MongoDB's aggregation expression language
                // does NOT expose `$nin`. `$nin` is a *query operator*
                // (valid only inside `$match.<field>: {$nin: [...]}`),
                // not an aggregation expression operator. Inside `$expr`
                // (where mongosql lands its NOT IN translation), the
                // server rejects `{$nin: [...]}` with `code 168:
                // Unrecognized expression '$nin'`. The correct
                // expression-context spelling is `{$not: {$in: [...]}}`,
                // verified empirically against atlas-local with a
                // `db.orders.aggregate([{$match: {$expr: {$not: {$in:
                // ["$account_id", ["acct_a"]]}}}}])` probe.
                //
                // MINOR-6: defensive collision check, same rationale as
                // the `$or` branch above. mongosql does not co-emit
                // `$not` with `$and` at the same level.
                debug_assert!(
                    !doc.contains_key("$not"),
                    "BUG: $and-collapse would overwrite sibling $not in same document; \
                     mongosql never emits this shape — see MINOR-6 in pipeline_rewrite.rs",
                );
                let mut inner = Document::new();
                inner.insert("$in", in_expr);
                doc.insert("$not", Bson::Document(inner));
            }
        }
        return;
    }

    // Re-insert the (now flat) boolean array.
    doc.insert(op.key(), Bson::Array(elements));
}

/// Iteratively flatten a boolean (`$or` / `$and`) array: any element
/// that is itself a `{<op>: [...]}` document has its inner array
/// spliced into the parent.
///
/// Stack-safe: works against an N-deep right-leaning chain (or any tree
/// shape) without recursing. Uses an explicit work queue.
fn flatten_bool_array(elements: Vec<Bson>, op: BoolOp) -> Vec<Bson> {
    let mut out: Vec<Bson> = Vec::with_capacity(elements.len());
    // Work queue holds elements left to inspect. Push in reverse so that
    // the final `out` preserves the original left-to-right order
    // (critical for the `$in` / `$nin` order-preservation property).
    let mut work: Vec<Bson> = Vec::with_capacity(elements.len());
    for e in elements.into_iter().rev() {
        work.push(e);
    }
    while let Some(elem) = work.pop() {
        match elem {
            Bson::Document(mut d) => {
                // MINOR-2: if the doc is a pure single-key wrapper for
                // our boolean op (`{<op>: [...]}` with nothing else),
                // splice its array into the parent. If it carries
                // sibling keys (e.g. `{$or: [...], $comment: "..."}`
                // — mongosql doesn't emit this but be defensive) we
                // keep it whole rather than risk dropping the sibling
                // metadata. `same_op_with_siblings_kept_whole` pins
                // this.
                let is_pure_wrapper =
                    d.len() == 1 && matches!(d.get(op.key()), Some(Bson::Array(_)));
                if is_pure_wrapper {
                    if let Some(Bson::Array(inner)) = d.remove(op.key()) {
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

/// If every element of `elements` is a same-field same-leaf-operator
/// expression against a literal scalar, return `(field_ref, values)`
/// where `field_ref` is the `$<field>` operand and `values` are the
/// literal RHS values in original left-to-right order.
///
/// `leaf_op` is the expected operator (`"$eq"` for `$or` collapse,
/// `"$ne"` for `$and` collapse).
///
/// Returns `None` if:
/// - `elements` is empty,
/// - any element isn't a `Bson::Document` with a single `leaf_op` key,
/// - the operand isn't a 2-element array `[<field_ref>, <literal>]`,
/// - the field ref doesn't start with `$` (i.e. isn't a field reference),
/// - the field refs across operands don't match,
/// - the RHS contains a non-literal expression (anything starting with
///   `$` that isn't wrapped in `$literal`).
///
/// `{$literal: x}` is unwrapped iff the inner value is "obviously
/// safe" (see [`extract_literal`]) — otherwise the wrapper is
/// preserved so that `$in` / `$nin` evaluation honours the literal
/// semantics. Bare BSON literals (Bson::String,
/// Bson::Int64, Bson::Decimal128, Bson::DateTime, Bson::ObjectId, etc.)
/// are accepted as-is.
fn try_collect_same_field_leaf(elements: &[Bson], leaf_op: &str) -> Option<(String, Vec<Bson>)> {
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
        // We accept the `$expr`-style operator form `{<leaf_op>: [a,
        // b]}` exclusively. The `$match`-style query operator form
        // `{<field>: {<leaf_op>: <lit>}}` would have a non-`$`-prefixed
        // top-level key; we don't collapse those because the
        // collapse-target `$in` / `$nin` is also operator-form and
        // would change the semantics in an unsafe way.
        if doc.len() != 1 {
            return None;
        }
        let (k, v) = doc.iter().next()?;
        if k != leaf_op {
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

/// Try to extract a literal value from a leaf-operator RHS. Returns:
///
/// - `Some(x)` if `b` is a bare BSON literal (String, Int32, Int64,
///   Double, Decimal128, DateTime, ObjectId, Boolean, Null, Binary,
///   Symbol), or `{$literal: x}` where the inner value is obviously
///   safe to unwrap.
/// - `Some({$literal: x})` (wrapper preserved) if `b` is
///   `{$literal: x}` where `x` would be reinterpreted as an
///   expression / field reference if unwrapped. Specifically:
///   `x` is `Bson::String` starting with `$` (any number of `$`s —
///   `"$"`, `"$x"`, `"$$var"`), or `x` is a `Bson::Document`
///   containing at least one `$`-prefixed key (could be an operator
///   like `{$abs: ...}`). Both `$in` and `$nin` evaluate
///   `{$literal: x}` element-by-element to `x`, so the result-set
///   semantics are identical to unwrapping — but unwrapping a
///   `$`-prefixed string would turn the value into a field reference
///   at evaluation time, which would be a real correctness bug.
/// - `None` if `b` is a bare `Bson::String` starting with `$` (field
///   reference / variable — NOT a literal), or a document with any
///   `$`-prefixed key that isn't `$literal` (an expression, not a
///   literal), or an Array (we don't collapse nested-array operands).
fn extract_literal(b: &Bson) -> Option<Bson> {
    match b {
        // `{$literal: x}` is the safe form. Decide whether unwrapping is
        // semantically safe (no field-reference / operator confusion) or
        // whether we must preserve the wrapper.
        Bson::Document(d) if d.len() == 1 => {
            if let Some(inner) = d.get("$literal") {
                if literal_wrapper_must_be_preserved(inner) {
                    // Preserve `{$literal: x}` as-is. `$in` / `$nin`
                    // arrays evaluate `{$literal: x}` to `x`, so the
                    // collapse is still correct semantically.
                    return Some(Bson::Document(d.clone()));
                }
                return Some(inner.clone());
            }
            // Single-key document that isn't `$literal` — could be an
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

/// Decide whether the inner value of a `{$literal: x}` wrapper would be
/// misinterpreted as an expression / field reference if we dropped the
/// wrapper. If so, callers MUST keep the wrapper around the value when
/// it lands in a `$in` / `$nin` array. See [`extract_literal`].
fn literal_wrapper_must_be_preserved(inner: &Bson) -> bool {
    match inner {
        // A `$`-prefixed string would be interpreted as a field
        // reference inside the `$in` / `$nin` value array — must keep
        // the wrapper. Includes `"$$var"` and bare `"$"` for
        // completeness.
        Bson::String(s) if s.starts_with('$') => true,
        // A document containing any `$`-prefixed key would be
        // interpreted as an operator expression. Keep the wrapper.
        Bson::Document(d) => d.keys().any(|k| k.starts_with('$')),
        _ => false,
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

    /// Helper: build a right-leaning `$and` chain of N `$ne` leaves on
    /// the same field. Used by the NOT-IN coverage tests.
    fn build_right_leaning_and_chain(field: &str, values: &[i64]) -> Document {
        assert!(values.len() >= 2);
        let last_two = values.len() - 2;
        let mut current = doc! {
            "$and": [
                doc! {"$ne": [format!("${field}"), values[last_two]]},
                doc! {"$ne": [format!("${field}"), values[last_two + 1]]},
            ],
        };
        for i in (0..last_two).rev() {
            let leaf = doc! {"$ne": [format!("${field}"), values[i]]};
            current = doc! {
                "$and": [Bson::Document(leaf), Bson::Document(current)],
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

    fn and_array(d: &Document) -> &Vec<Bson> {
        match d.get("$and") {
            Some(Bson::Array(a)) => a,
            other => panic!("expected $and array, got {other:?}"),
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        // mongosql's preferred RHS form is `{$literal: x}`. Must unwrap
        // for plain strings; result must compare against the LITERAL
        // values "a"/"b".
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", { "$literal": "a" }]},
                doc! {"$eq": ["$x", { "$literal": "b" }]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        let in_args = input.get_array("$in").expect("$in");
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals.len(), 3);
        assert_eq!(vals[0], Bson::Decimal128(dec));
        assert_eq!(vals[1], Bson::DateTime(dt));
        assert_eq!(vals[2], Bson::ObjectId(oid));
    }

    // ----- MAJOR-2: $literal wrapper preservation for $-prefixed strings -----

    #[test]
    fn collapse_preserves_literal_wrapper_for_dollar_prefixed_string() {
        // MAJOR-2: unwrapping `{$literal: "$evil_field"}` to a bare
        // `"$evil_field"` would turn the value into a field reference
        // at `$in` evaluation time. The wrapper must be preserved.
        //
        // We still allow the collapse to fire because both `$in` and
        // `$nin` evaluate `{$literal: x}` element-by-element to `x` —
        // so the semantics remain "compare equal to the literal string
        // $evil_field", which is what the user wrote.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", { "$literal": "$evil_field_ref" }]},
                doc! {"$eq": ["$x", { "$literal": "ok" }]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        let in_args = input.get_array("$in").expect("$in");
        let vals = in_args[1].as_array().unwrap();
        // First value retains the wrapper.
        let first = &vals[0];
        let first_doc = first
            .as_document()
            .expect("first value must remain wrapped in $literal");
        assert_eq!(first_doc.len(), 1);
        assert_eq!(
            first_doc.get_str("$literal").ok(),
            Some("$evil_field_ref"),
            "wrapper must preserve the literal $-prefixed string",
        );
        // Second value (no dollar prefix) is unwrapped to the bare
        // string, as before.
        assert_eq!(vals[1].as_str(), Some("ok"));
    }

    #[test]
    fn collapse_preserves_literal_wrapper_for_inner_dollar_keyed_doc() {
        // `{$literal: {$abs: ...}}` would mean "the literal value is
        // a sub-document whose key is `$abs`". Unwrapped, that
        // sub-document would be evaluated as the `$abs` operator at
        // `$in` evaluation. Preserve the wrapper so the value is
        // treated as a literal embedded doc.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", { "$literal": doc! {"$abs": -1_i64} }]},
                doc! {"$eq": ["$x", { "$literal": doc! {"$abs": -2_i64} }]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        let in_args = input.get_array("$in").expect("$in");
        let vals = in_args[1].as_array().unwrap();
        for v in vals.iter() {
            let d = v
                .as_document()
                .expect("each value must remain wrapped in $literal");
            assert_eq!(d.len(), 1);
            assert!(d.contains_key("$literal"));
        }
    }

    #[test]
    fn collapse_preserves_literal_wrapper_for_double_dollar_string() {
        // `"$$var"` looks like a variable reference. Preserve the
        // wrapper to keep the literal interpretation.
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", { "$literal": "$$var" }]},
                doc! {"$eq": ["$x", { "$literal": "ok" }]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        let in_args = input.get_array("$in").expect("$in");
        let vals = in_args[1].as_array().unwrap();
        let d = vals[0]
            .as_document()
            .expect("$$var must remain wrapped in $literal");
        assert_eq!(d.get_str("$literal").ok(), Some("$$var"));
        assert_eq!(vals[1].as_str(), Some("ok"));
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        assert!(input.contains_key("$or"));
        assert!(!input.contains_key("$in"));
    }

    // ----- MINOR-2: pure-wrapper guard -----

    #[test]
    fn same_op_with_siblings_kept_whole() {
        // MINOR-2: a `{$or: [...], $comment: "..."}` document inside a
        // parent `$or` array is NOT a pure wrapper — splicing would
        // silently drop the `$comment`. We keep it whole and let the
        // outer collapse decide what to do (in practice the collapse
        // will REJECT because the element isn't a `{$eq: [...]}` leaf,
        // so the result is a flat `$or` with the sibling-bearing doc
        // preserved).
        let mut input = doc! {
            "$or": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {
                    "$or": [
                        doc! {"$eq": ["$x", 2_i64]},
                        doc! {"$eq": ["$x", 3_i64]},
                    ],
                    "$comment": "do-not-drop-me",
                },
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        // Must NOT collapse to $in — the sibling-bearing doc is opaque
        // to the leaf check.
        assert!(input.contains_key("$or"));
        assert!(!input.contains_key("$in"));
        let arr = or_array(&input);
        assert_eq!(arr.len(), 2);
        // First leaf is the bare $eq.
        let first = arr[0].as_document().unwrap();
        assert!(first.contains_key("$eq"));
        // Second element is the WHOLE sibling-bearing wrapper, untouched.
        let second = arr[1].as_document().unwrap();
        assert!(second.contains_key("$or"));
        assert_eq!(
            second.get_str("$comment").ok(),
            Some("do-not-drop-me"),
            "sibling key must not be dropped during flatten",
        );
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
        // (try_collect_same_field_leaf returns None on empty input).
        let mut input = doc! {"$or": []};
        rewrite_bool_in_place(&mut input, BoolOp::Or);
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

    // ----- $and / $nin support (NOT IN coverage) -----

    #[test]
    fn collapse_same_field_ne_chain_to_not_in() {
        // {$and: [{$ne:["$x",1]},{$ne:["$x",2]},{$ne:["$x",3]}]} →
        // {$not: {$in: ["$x", [1,2,3]]}}
        //
        // CRITICAL: $nin is NOT a valid aggregation expression
        // operator (it's only a $match query operator). Inside $expr
        // the server rejects `{$nin: [...]}` with code 168. Emit
        // `{$not: {$in: ...}}` instead — verified empirically.
        let mut input = doc! {
            "$and": [
                doc! {"$ne": ["$x", 1_i64]},
                doc! {"$ne": ["$x", 2_i64]},
                doc! {"$ne": ["$x", 3_i64]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::And);
        assert!(!input.contains_key("$and"), "$and should be replaced");
        assert!(
            !input.contains_key("$nin"),
            "$nin is invalid in $expr — must NOT be emitted",
        );
        let not_doc = input.get_document("$not").expect("$not document");
        let in_args = not_doc.get_array("$in").expect("$not.$in array");
        assert_eq!(in_args.len(), 2);
        assert_eq!(in_args[0], Bson::String("$x".to_string()));
        let vals = in_args[1].as_array().expect("values");
        assert_eq!(vals.len(), 3);
        assert_eq!(vals[0].as_i64(), Some(1));
        assert_eq!(vals[1].as_i64(), Some(2));
        assert_eq!(vals[2].as_i64(), Some(3));
    }

    #[test]
    fn flatten_nested_and_collapses_to_flat_array() {
        // {$and: [A, {$and: [B, {$and: [C, D]}]}]} → {$and: [A, B, C, D]}
        let a = doc! {"a": 1};
        let b = doc! {"b": 2};
        let c = doc! {"c": 3};
        let d = doc! {"d": 4};
        let mut input = doc! {
            "$and": [
                Bson::Document(a.clone()),
                Bson::Document(doc! {
                    "$and": [
                        Bson::Document(b.clone()),
                        Bson::Document(doc! {
                            "$and": [Bson::Document(c.clone()), Bson::Document(d.clone())],
                        }),
                    ],
                }),
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::And);
        let arr = and_array(&input);
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0], Bson::Document(a));
        assert_eq!(arr[1], Bson::Document(b));
        assert_eq!(arr[2], Bson::Document(c));
        assert_eq!(arr[3], Bson::Document(d));
    }

    #[test]
    fn flatten_handles_165_deep_and_chain_without_stack_overflow() {
        // Symmetric to `flatten_handles_165_deep_chain_without_stack_overflow`
        // for `$and`. Pins NOT-IN coverage against a deep right-leaning
        // chain (which is what an Atlas SQL proxy re-expansion produces
        // server-side for large NOT IN lists). The post-collapse shape
        // is `{$not: {$in: [...]}}` (NOT `$nin` — invalid in $expr).
        let values: Vec<i64> = (0..165).collect();
        let input_doc = build_right_leaning_and_chain("x", &values);
        let mut pipeline = vec![doc! {
            "$match": { "$expr": Bson::Document(input_doc) }
        }];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let stage = &pipeline[0];
        let expr = stage.get_document("$match").unwrap().get("$expr").unwrap();
        let expr_doc = expr.as_document().expect("expr document");
        assert!(
            !expr_doc.contains_key("$nin"),
            "$nin must never appear in $expr; got {expr_doc:?}",
        );
        if let Some(Bson::Document(not_doc)) = expr_doc.get("$not") {
            let in_args = not_doc.get_array("$in").expect("$not.$in array");
            assert_eq!(in_args.len(), 2);
            assert_eq!(in_args[0], Bson::String("$x".to_string()));
            let vals = in_args[1].as_array().expect("values array");
            assert_eq!(vals.len(), 165);
            for (i, v) in vals.iter().enumerate() {
                assert_eq!(v.as_i64(), Some(i as i64));
            }
        } else if let Some(Bson::Array(and_arr)) = expr_doc.get("$and") {
            assert_eq!(and_arr.len(), 165);
        } else {
            panic!("expected $not.$in or flat $and; got {expr_doc:?}");
        }
    }

    #[test]
    fn collapse_skipped_for_and_with_different_fields() {
        let mut input = doc! {
            "$and": [
                doc! {"$ne": ["$x", 1_i64]},
                doc! {"$ne": ["$y", 2_i64]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::And);
        assert!(input.contains_key("$and"));
        assert!(!input.contains_key("$not"));
    }

    #[test]
    fn collapse_skipped_for_and_with_non_ne_leaf() {
        // $and over different operators (e.g. range filter) is NOT a
        // NOT-IN — leave it alone.
        let mut input = doc! {
            "$and": [
                doc! {"$ne": ["$x", 1_i64]},
                doc! {"$gt": ["$x", 2_i64]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::And);
        assert!(input.contains_key("$and"));
        assert!(!input.contains_key("$not"));
    }

    #[test]
    fn collapse_skipped_for_and_with_eq_leaf() {
        // `$and` with `$eq` leaves doesn't form a NOT-IN (it'd be a
        // contradiction unless all values equal — not our shape). Leave
        // it as flat $and.
        let mut input = doc! {
            "$and": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {"$eq": ["$x", 2_i64]},
            ],
        };
        rewrite_bool_in_place(&mut input, BoolOp::And);
        assert!(input.contains_key("$and"));
        assert!(!input.contains_key("$not"));
    }

    #[test]
    fn nested_and_inside_expr_let_cond_collapses_to_not_in() {
        // Mirrors `nested_inside_expr_let_cond` for the NOT-IN path.
        // Post-collapse shape is `{$not: {$in: [...]}}`.
        let values: Vec<i64> = (0..5).collect();
        let chain = build_right_leaning_and_chain("x", &values);
        let mut pipeline = vec![doc! {
            "$match": {
                "$expr": {
                    "$let": {
                        "vars": { "tmp": "$some_field" },
                        "in": {
                            "$cond": {
                                "if": Bson::Document(chain),
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
        let inner_doc = inner.as_document().unwrap();
        assert!(!inner_doc.contains_key("$nin"), "$nin invalid in $expr");
        let not_doc = inner_doc.get_document("$not").expect("collapsed to $not");
        let in_args = not_doc.get_array("$in").expect("$not.$in");
        assert_eq!(in_args[0], Bson::String("$x".to_string()));
        let vals = in_args[1].as_array().unwrap();
        assert_eq!(vals.len(), 5);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_i64(), Some(i as i64));
        }
    }

    // ----- MINOR-4: walker short-circuits on $in / $nin value arrays -----

    #[test]
    fn walker_does_not_descend_into_in_value_array() {
        // MINOR-4: even if a `$or` literally appears inside an `$in`
        // value array (which is illegal MQL but possible in malformed
        // input), the walker MUST NOT rewrite it. The `$in` array is a
        // pure value list by contract.
        let mut pipeline = vec![doc! {
            "$match": {
                "$expr": {
                    "$in": [
                        "$x",
                        [
                            // A bare doc with `$or` literal — pretend
                            // someone tries to smuggle one in. The
                            // walker must leave it byte-identical.
                            doc! {
                                "$or": [
                                    doc! {"$eq": ["$y", 1_i64]},
                                    doc! {"$eq": ["$y", 2_i64]},
                                ],
                            },
                            "ok",
                        ],
                    ],
                },
            },
        }];
        let snapshot = pipeline.clone();
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        assert_eq!(
            pipeline, snapshot,
            "walker must not descend into $in value arrays",
        );
    }

    // ----- MINOR-6: sibling $in / $not preserved when collapse doesn't fire -----

    #[test]
    fn or_with_sibling_in_does_not_overwrite() {
        // MINOR-6 defensive paranoia: if mongosql ever emitted a shape
        // like `{$or: [non-collapsible-leaves...], $in: [...]}` at the
        // same level, the existing `$in` key must survive the rewrite
        // (the `$or` collapse precondition is not met, so the
        // `doc.insert("$in", ...)` branch in `rewrite_bool_in_place` is
        // never taken). In practice mongosql never co-emits these two
        // operators at the same level, so this test pins the
        // conservative behaviour for a synthetic input.
        let mut input = doc! {
            // `$or` over different-field leaves — collapse precondition
            // FAILS (different fields), so `$in` insert path is NOT
            // taken.
            "$or": [
                doc! {"$eq": ["$x", 1_i64]},
                doc! {"$eq": ["$y", 2_i64]},
            ],
            // Sibling `$in` that pre-existed. Must survive.
            "$in": Bson::Array(vec![Bson::String("$z".to_string()), Bson::Array(vec![Bson::Int64(99)])]),
        };
        rewrite_bool_in_place(&mut input, BoolOp::Or);
        // `$or` stays (flat, since collapse rejected); the original `$in`
        // is preserved byte-identically.
        assert!(input.contains_key("$or"));
        let in_args = input.get_array("$in").expect("original $in preserved");
        assert_eq!(in_args.len(), 2);
        assert_eq!(in_args[0], Bson::String("$z".to_string()));
        let vals = in_args[1].as_array().expect("values");
        assert_eq!(vals.len(), 1);
        assert_eq!(vals[0].as_i64(), Some(99));
    }

    #[test]
    fn and_with_sibling_not_does_not_overwrite() {
        // Symmetric to `or_with_sibling_in_does_not_overwrite` for
        // `$and` + `$not`. mongosql doesn't co-emit these at the same
        // level either; this pins the conservative behaviour.
        let mut input = doc! {
            "$and": [
                doc! {"$ne": ["$x", 1_i64]},
                doc! {"$gt": ["$x", 2_i64]}, // non-`$ne` leaf, collapse rejected
            ],
            "$not": doc! {"$in": [Bson::String("$z".to_string()), [99_i64]]},
        };
        rewrite_bool_in_place(&mut input, BoolOp::And);
        assert!(input.contains_key("$and"));
        let not_doc = input.get_document("$not").expect("original $not preserved");
        let in_args = not_doc
            .get_array("$in")
            .expect("original $not.$in preserved");
        assert_eq!(in_args.len(), 2);
        assert_eq!(in_args[0], Bson::String("$z".to_string()));
        let vals = in_args[1].as_array().expect("values");
        assert_eq!(vals.len(), 1);
        assert_eq!(vals[0].as_i64(), Some(99));
    }

    #[test]
    fn walker_does_not_descend_into_nin_value_array() {
        // Same as above but for `$nin`.
        let mut pipeline = vec![doc! {
            "$match": {
                "$expr": {
                    "$nin": [
                        "$x",
                        [
                            doc! {
                                "$and": [
                                    doc! {"$ne": ["$y", 1_i64]},
                                    doc! {"$ne": ["$y", 2_i64]},
                                ],
                            },
                            "ok",
                        ],
                    ],
                },
            },
        }];
        let snapshot = pipeline.clone();
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        assert_eq!(
            pipeline, snapshot,
            "walker must not descend into $nin value arrays",
        );
    }
}

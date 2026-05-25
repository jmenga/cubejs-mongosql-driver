//! Post-translation pipeline rewriter — flattens nested `$or` / `$and`
//! chains, collapses same-field `$eq` / `$ne` disjunctions to
//! `$in` / `$nin`, AND collapses mongosql's `$let`-wrapped IN-list
//! shape (the form mongosql v1.8.5 emits when an `IN (…)` filter
//! co-exists with a `GROUP BY` in the same SQL) into a single `$in`.
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
//! ## `$let`-wrapped IN-list shape (the third rewrite)
//!
//! When a SQL query mixes `IN (v1, …, vN)` with `GROUP BY` (or any other
//! construct that triggers mongosql's let-binding for the IN-list LHS),
//! the translator emits this shape (verified empirically against the
//! real Atlas SQL endpoint for N=3, N=5, N=161):
//!
//! ```json
//! {
//!   "$let": {
//!     "vars": {
//!       "desugared_sqlOr_input0": {
//!         "$let": {
//!           "vars": { "desugared_sqlEq_input0": "$<source_field>" },
//!           "in": {
//!             "$cond": [
//!               { "$lte": ["$$desugared_sqlEq_input0", { "$literal": null }] },
//!               { "$literal": null },
//!               { "$eq":  ["$$desugared_sqlEq_input0", { "$literal": "v0" }] }
//!             ]
//!           }
//!         }
//!       },
//!       "desugared_sqlOr_input1": { /* … same shape, RHS literal "v1" … */ },
//!       /* … N inputs total … */
//!     },
//!     "in": {
//!       "$cond": [
//!         { "$or": [
//!             { "$eq": ["$$desugared_sqlOr_input0", { "$literal": true }] },
//!             /* … N entries … */
//!         ] },
//!         { "$literal": true },
//!         { "$cond": [
//!             { "$or": [
//!                 { "$lte": ["$$desugared_sqlOr_input0", { "$literal": null }] },
//!                 /* … N entries … */
//!             ] },
//!             { "$literal": null },
//!             { "$literal": false }
//!         ] }
//!       ]
//!     }
//!   }
//! }
//! ```
//!
//! The outer `$let` evaluates to `true` if any operand evaluates `true`;
//! to `null` if every operand evaluates `null` (i.e. the source field is
//! null/missing); to `false` otherwise. Since every per-operand `$let`
//! reads the SAME source field and applies the SAME null-handling, the
//! whole construct is semantically equivalent to:
//!
//! ```json
//! {
//!   "$cond": [
//!     { "$lte": ["$<source_field>", { "$literal": null }] },
//!     { "$literal": null },
//!     { "$in":  ["$<source_field>", [v0, v1, …, vN-1]] }
//!   ]
//! }
//! ```
//!
//! The Atlas SQL proxy cannot re-expand a `$in` value array into a
//! right-leaning chain (there is no n-ary boolean array left to
//! chain-ify), so the BSON-depth overflow goes away. The replacement
//! `$cond.then`/`$cond.else` branches in `$expr` still evaluate to
//! `true`, `null`, or `false` — semantically identical to the original
//! (`$expr` filters out documents whose top-level expression evaluates
//! to `null`/`false`/`0` and keeps documents whose expression is
//! `truthy`).
//!
//! Detection is **conservative**:
//!  - the outer `$let` must have ≥ 2 vars, all named with the
//!    `desugared_sqlOr_input` prefix (a future mongosql release that
//!    changes the prefix would silently disable this collapse, falling
//!    back to the flat-`$or` shape that already works for N ≤ 99);
//!  - every var's value must be a single-key `$let` whose inner `vars`
//!    bind exactly one key (any name) to a single string starting with
//!    `$` (the SAME field across all operands) and whose inner `in` is
//!    the 3-element `$cond` array
//!    `[<null-check>, {$literal: null}, {$eq: ["$$<inner-var>", <literal>]}]`;
//!  - the outer `$let.in` must be the 3-element `$cond` array shape
//!    whose `if` is a `$or` of
//!    `{$eq: ["$$desugared_sqlOr_inputN", {$literal: true}]}` operands
//!    (in any order — we match by var-name, not positional), whose
//!    `then` is `{$literal: true}`, and whose `else` is the inner null-
//!    propagation `$cond` over the SAME set of vars.
//!
//! ANY deviation → the collapse aborts and the document is left alone.
//! The `collapse_mongosql_in_list_let_skipped_*` tests pin the negative
//! cases.
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
/// `unwrap_pipeline`. Walks every stage and applies all three rewrites
/// at each level: flatten + collapse `$or`, flatten + collapse `$and`,
/// AND collapse mongosql's `$let`-wrapped IN-list shape into a single
/// `$cond`-wrapped `$in` (see [`collapse_mongosql_in_list_let`]).
/// The function name is kept narrow for historical/diff-stability
/// reasons; the IN-list-let collapse is the third rewrite this pass
/// performs.
///
/// Performance: for queries with no boolean disjunction/conjunction
/// and no `$let`-wrapped IN-list anywhere in the pipeline this is a
/// linear pass over the BSON nodes with no allocations beyond a single
/// boolean per recursive call.
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
    // Try the `$let`-wrapped IN-list collapse FIRST at this level. When
    // it fires it replaces the entire `$let` slot with a `$cond`-wrapped
    // `$in` (see [`collapse_mongosql_in_list_let`]). Running it before
    // descent saves walking the (about-to-be-replaced) per-operand
    // `$let` subtrees and their N inner `$or` checks. When the shape
    // doesn't match, the call is a cheap no-op pass-through.
    if doc.contains_key("$let") {
        collapse_mongosql_in_list_let(doc);
    }

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

/// mongosql's let-binding prefix for the per-operand IN-list var slots.
///
/// Verified by the in-tree probe (`crates/native/tests/critic_probe.rs`)
/// against both the local YAML fixture catalog and the real Atlas SQL
/// endpoint's `sqlGetSchema`-derived catalog. A future mongosql release
/// that changes this prefix would silently disable the let-aware
/// collapse; the fallback (flat `$or`) still works for N ≤ 99 (the BSON-
/// depth cliff is at ~100). We use a name-prefix check rather than
/// purely structural detection because the outer-`$let` shape is also
/// produced for benign constructs (e.g. `BETWEEN`, top-level `AND`,
/// `IS NOT NULL`); pure structural detection would risk false
/// positives.
const SQL_OR_INPUT_PREFIX: &str = "desugared_sqlOr_input";

/// Try to collapse mongosql's `$let`-wrapped IN-list shape into a
/// single `$in`. Returns `true` when the collapse fires (the document's
/// `$let` slot is removed and replaced with a `$cond` carrying the
/// `$in`); `false` when the shape does not match.
///
/// Caller has already verified `doc.contains_key("$let")`. See the
/// module docstring for the exact shape we match against and why the
/// replacement is semantics-preserving.
///
/// # Conservative matching
///
/// Every check below MUST pass — the moment a check fails we abort and
/// leave the document byte-identical. We deliberately err on the side
/// of false negatives (rather than risk rewriting a `$let` whose
/// semantics aren't this exact mongosql IN-list emission, which would
/// produce silently-wrong query results). The module docstring lists
/// the criteria; the `collapse_mongosql_in_list_let_skipped_*` tests
/// pin the negatives.
pub(crate) fn collapse_mongosql_in_list_let(doc: &mut Document) -> bool {
    // The `$let` value must itself be a document carrying exactly the
    // pair {vars, in} (a third key would mean we don't recognise this
    // mongosql emission shape).
    let let_doc = match doc.get("$let") {
        Some(Bson::Document(d)) => d,
        _ => return false,
    };
    if let_doc.len() != 2 {
        return false;
    }
    let vars = match let_doc.get("vars") {
        Some(Bson::Document(v)) => v,
        _ => return false,
    };
    if vars.len() < 2 {
        // A single-element IN list is never the pathological shape
        // (no BSON-depth risk) — and mongosql may not produce the same
        // `$let.vars[*]` IN-list emission for 1 value anyway. Skip.
        return false;
    }

    // Every var must be named with the SQL_OR_INPUT_PREFIX prefix. We
    // accept any suffix (numeric is what mongosql emits today, but the
    // prefix-only check is the load-bearing one — see
    // SQL_OR_INPUT_PREFIX doc comment for the rationale).
    if !vars.keys().all(|k| k.starts_with(SQL_OR_INPUT_PREFIX)) {
        return false;
    }

    // Parse every var's value into (inner_var_name, source_field,
    // literal). All operands must share the same source field. The
    // inner var name (e.g. `desugared_sqlEq_input0`) is captured per-
    // operand so we can verify the inner `$cond` references it
    // consistently.
    let mut source_field: Option<String> = None;
    // (var_name, literal) preserving insertion order — we won't rely
    // on this order for the output `$in` array (we use the outer-`$or`
    // referenced order instead, which IS the user-source order), but
    // the vector form lets us look up by var name later without a
    // second map allocation.
    let mut literal_by_var: Vec<(String, Bson)> = Vec::with_capacity(vars.len());
    for (var_name, var_value) in vars.iter() {
        let parsed = match parse_in_list_per_operand_let(var_value) {
            Some(p) => p,
            None => return false,
        };
        match &source_field {
            None => source_field = Some(parsed.source_field.clone()),
            Some(prev) if *prev == parsed.source_field => {}
            Some(_) => return false,
        }
        literal_by_var.push((var_name.clone(), parsed.literal));
    }
    let source_field = match source_field {
        Some(f) => f,
        None => return false,
    };

    // Outer `$let.in` must be a 3-element `$cond` array whose `if` is a
    // `$or` of `{$eq: ["$$desugared_sqlOr_inputN", {$literal: true}]}`
    // operands. We capture the order of var names as they appear in the
    // `$or`, because THAT is the user-source order (the `vars` map's
    // iteration order is `IndexMap`-stable but not guaranteed to match
    // the user's left-to-right `IN (…)` order). The same call also
    // validates the `then`-branch is `{$literal: true}` and the `else`-
    // branch is the inner null-propagation `$cond`.
    let order = match parse_in_list_outer_cond(let_doc.get("in"), vars.len()) {
        Some(o) => o,
        None => return false,
    };

    // Reorder literals to match the outer-`$or` reference order. This
    // is the cross-check that catches a mismatched var name set
    // (e.g. `vars` defines varA/varB but the outer `$or` references
    // varA/varC) — a missing var triggers `position(..) == None` and
    // we abort.
    let mut values: Vec<Bson> = Vec::with_capacity(order.len());
    for var_name in &order {
        let pos = match literal_by_var.iter().position(|(k, _)| k == var_name) {
            Some(p) => p,
            None => return false,
        };
        values.push(literal_by_var[pos].1.clone());
    }

    // Build the replacement: a `$cond` whose `if` is the null-check
    // against the source field, whose `then` is `{$literal: null}`, and
    // whose `else` is the `$in` against the same source field. The `$in`
    // honours MongoDB's natural semantics for missing/null values
    // (returns `null` on missing source — which matches the original
    // `$let` evaluating to `null` for that case), so the explicit null-
    // check is defensive but semantically equivalent to the original
    // outer `$let`'s null-propagation cond.
    let in_args = Bson::Array(vec![
        Bson::String(source_field.clone()),
        Bson::Array(values),
    ]);
    let lte_args = Bson::Array(vec![
        Bson::String(source_field),
        Bson::Document({
            let mut d = Document::new();
            d.insert("$literal", Bson::Null);
            d
        }),
    ]);
    let cond_args = Bson::Array(vec![
        Bson::Document({
            let mut d = Document::new();
            d.insert("$lte", lte_args);
            d
        }),
        Bson::Document({
            let mut d = Document::new();
            d.insert("$literal", Bson::Null);
            d
        }),
        Bson::Document({
            let mut d = Document::new();
            d.insert("$in", in_args);
            d
        }),
    ]);

    // Swap the `$let` slot for a `$cond`. Sibling keys at the parent
    // level (defensive — mongosql doesn't emit them alongside this
    // shape) are preserved; the `$let` key is removed and a `$cond`
    // key is appended (the `IndexMap` semantics match the existing
    // `rewrite_bool_in_place` behaviour). When the parent is itself an
    // `$expr` body or a `$cond.if` branch (the typical landing places),
    // the resulting `$cond` is a valid drop-in replacement.
    doc.remove("$let");
    doc.insert("$cond", cond_args);
    true
}

/// Parsed per-operand `$let` carrying a single IN-list value.
struct InListPerOperand {
    /// The source field reference (e.g. `"$agentId"` or
    /// `"$evaluationResults.evaluations.callQuality.score"`). Captured
    /// verbatim from the inner `$let.vars.<key>` value; dotted paths
    /// pass through unchanged.
    source_field: String,
    /// The RHS literal value (e.g. `{$literal: "v0"}`, or a bare scalar
    /// like a `Bson::Int64`). Preserved byte-identically via
    /// [`extract_literal`] — the wrapper is kept when the inner value
    /// would otherwise be reinterpreted as a field reference / operator
    /// inside the resulting `$in` array.
    literal: Bson,
}

/// Parse one per-operand `$let` from the outer-`$let.vars` map. Returns
/// `Some(InListPerOperand)` when the value matches the mongosql IN-list
/// per-operand shape, `None` otherwise.
///
/// The shape we accept (see the probe in `tests/critic_probe.rs`):
///
/// ```json
/// { "$let": {
///     "vars": { "<any-inner-var>": "$<source_field>" },
///     "in":   { "$cond": [
///       { "$lte": ["$$<any-inner-var>", { "$literal": null }] },
///       { "$literal": null },
///       { "$eq":  ["$$<any-inner-var>", <literal>] }
///     ]}
/// }}
/// ```
///
/// The `<any-inner-var>` name (`desugared_sqlEq_input0` in v1.8.5) is
/// captured from the `vars` map and required to be the SAME name in
/// both `$lte` and `$eq` arms — this guards against false-positive
/// rewrites of structurally similar `$let`s that bind multiple vars.
fn parse_in_list_per_operand_let(value: &Bson) -> Option<InListPerOperand> {
    let outer = value.as_document()?;
    if outer.len() != 1 {
        return None;
    }
    let inner = outer.get_document("$let").ok()?;
    if inner.len() != 2 {
        return None;
    }
    let vars = inner.get_document("vars").ok()?;
    if vars.len() != 1 {
        return None;
    }
    let (inner_var_name, inner_var_value) = vars.iter().next()?;
    // The inner var must bind to a field reference string (a single `$`
    // prefix; dotted paths allowed). Bare `$` or `$$<var>` reject — we
    // need a field reference, not a variable reference.
    let source_field = match inner_var_value {
        Bson::String(s) if s.starts_with('$') && !s.starts_with("$$") => s.clone(),
        _ => return None,
    };

    // `in` must be a single-key document carrying a `$cond` array of 3.
    let in_doc = inner.get_document("in").ok()?;
    if in_doc.len() != 1 {
        return None;
    }
    let cond_arr = in_doc.get_array("$cond").ok()?;
    if cond_arr.len() != 3 {
        return None;
    }
    // Element 0: { $lte: ["$$<inner_var>", { $literal: null }] }
    if !is_null_lte_check(&cond_arr[0], inner_var_name) {
        return None;
    }
    // Element 1: { $literal: null }
    if !is_literal_null(&cond_arr[1]) {
        return None;
    }
    // Element 2: { $eq: ["$$<inner_var>", <literal-or-{$literal: x}>] }
    let literal = parse_eq_against_inner_var(&cond_arr[2], inner_var_name)?;

    Some(InListPerOperand {
        source_field,
        literal,
    })
}

/// Match `{ $lte: ["$$<inner_var>", { $literal: null }] }`. Returns
/// `true` on exact-shape match, `false` otherwise.
fn is_null_lte_check(b: &Bson, inner_var: &str) -> bool {
    let d = match b.as_document() {
        Some(d) => d,
        None => return false,
    };
    if d.len() != 1 {
        return false;
    }
    let arr = match d.get_array("$lte") {
        Ok(a) => a,
        Err(_) => return false,
    };
    if arr.len() != 2 {
        return false;
    }
    let lhs_ok = matches!(&arr[0], Bson::String(s) if s == &format!("$${inner_var}"));
    let rhs_ok = is_literal_null(&arr[1]);
    lhs_ok && rhs_ok
}

/// Match `{ $literal: null }` (a wrapped null literal). A bare
/// `Bson::Null` (no wrapper) is NOT accepted — mongosql always wraps.
fn is_literal_null(b: &Bson) -> bool {
    let d = match b.as_document() {
        Some(d) => d,
        None => return false,
    };
    if d.len() != 1 {
        return false;
    }
    matches!(d.get("$literal"), Some(Bson::Null))
}

/// Match `{ $eq: ["$$<inner_var>", <literal-or-{$literal: x}>] }`.
/// Returns the literal RHS on success, preserving any `{$literal: x}`
/// wrapper for correctness — `$in` element evaluation treats
/// `{$literal: x}` as `x`, so the wrapper is safe and necessary for
/// `$`-prefixed strings / `$`-keyed sub-documents.
fn parse_eq_against_inner_var(b: &Bson, inner_var: &str) -> Option<Bson> {
    let d = b.as_document()?;
    if d.len() != 1 {
        return None;
    }
    let arr = d.get_array("$eq").ok()?;
    if arr.len() != 2 {
        return None;
    }
    let lhs_ok = matches!(&arr[0], Bson::String(s) if s == &format!("$${inner_var}"));
    if !lhs_ok {
        return None;
    }
    // RHS must be a literal — accept either a bare BSON scalar or a
    // `{$literal: x}` wrapper. Reject bare `$`-prefixed strings
    // (field references) and bare documents containing $-prefixed
    // keys (operator expressions). Reuse `extract_literal` so the same
    // safety rules apply as for the flat `$or` → `$in` collapse.
    extract_literal(&arr[1])
}

/// Parse the outer `$let.in` (a 3-element `$cond` array whose `if` is a
/// `$or` of `{$eq: ["$$<sqlOr_inputN>", {$literal: true}]}` operands).
/// On success returns the order of var names as referenced by the `$or`
/// — this is the order the resulting `$in` value array must take.
///
/// `expected_count` is the number of operands the outer `$let.vars`
/// map carried; the `$or` array must have the same length, the
/// `then`-branch must be `{$literal: true}`, and the `else`-branch
/// must be the inner null-propagation `$cond` over the SAME set of
/// vars.
fn parse_in_list_outer_cond(value: Option<&Bson>, expected_count: usize) -> Option<Vec<String>> {
    let in_doc = value?.as_document()?;
    if in_doc.len() != 1 {
        return None;
    }
    let cond_arr = in_doc.get_array("$cond").ok()?;
    if cond_arr.len() != 3 {
        return None;
    }

    // Element 0: the `if` is `{ $or: [ {$eq: ["$$varN", {$literal: true}]}, ... ] }`.
    let if_doc = cond_arr[0].as_document()?;
    if if_doc.len() != 1 {
        return None;
    }
    let or_arr = if_doc.get_array("$or").ok()?;
    if or_arr.len() != expected_count {
        return None;
    }
    let mut order: Vec<String> = Vec::with_capacity(or_arr.len());
    for op in or_arr {
        let var = parse_eq_var_is_true(op)?;
        order.push(var);
    }

    // Element 1: `{ $literal: true }` — the truthy then-branch of the
    // outer cond. Pinned because a mismatch here would mean the `$let`
    // does NOT evaluate to truthy when the `$or` is true.
    if !is_literal_bool(&cond_arr[1], true) {
        return None;
    }

    // Element 2: the inner null-propagation `$cond`. Validate its
    // SHAPE — skipping this risks rewriting a structurally similar
    // `$let` whose semantics differ.
    if !validate_inner_null_cond(&cond_arr[2], &order) {
        return None;
    }

    Some(order)
}

/// Match `{ $eq: ["$$<var>", { $literal: true }] }`. Returns
/// `Some("<var>")` (the var name without the `$$` prefix) on success.
fn parse_eq_var_is_true(b: &Bson) -> Option<String> {
    let d = b.as_document()?;
    if d.len() != 1 {
        return None;
    }
    let arr = d.get_array("$eq").ok()?;
    if arr.len() != 2 {
        return None;
    }
    let var = match &arr[0] {
        Bson::String(s) if s.starts_with("$$") => s[2..].to_string(),
        _ => return None,
    };
    if !is_literal_bool(&arr[1], true) {
        return None;
    }
    Some(var)
}

/// Match `{ $literal: <bool> }` for a specific boolean value.
fn is_literal_bool(b: &Bson, want: bool) -> bool {
    let d = match b.as_document() {
        Some(d) => d,
        None => return false,
    };
    if d.len() != 1 {
        return false;
    }
    matches!(d.get("$literal"), Some(Bson::Boolean(actual)) if *actual == want)
}

/// Validate the inner null-propagation `$cond`:
///
/// ```json
/// { "$cond": [
///   { "$or": [
///     { "$lte": ["$$<varN>", { "$literal": null }] }, …
///   ] },
///   { "$literal": null },
///   { "$literal": false }
/// ] }
/// ```
///
/// The `$or` operands must reference the SAME set of vars that the
/// outer `$or` referenced (in any order — we compare sorted snapshots).
/// Returns `true` on shape match.
fn validate_inner_null_cond(b: &Bson, expected_vars: &[String]) -> bool {
    let d = match b.as_document() {
        Some(d) => d,
        None => return false,
    };
    if d.len() != 1 {
        return false;
    }
    let arr = match d.get_array("$cond") {
        Ok(a) => a,
        Err(_) => return false,
    };
    if arr.len() != 3 {
        return false;
    }
    let if_doc = match arr[0].as_document() {
        Some(d) => d,
        None => return false,
    };
    if if_doc.len() != 1 {
        return false;
    }
    let or_arr = match if_doc.get_array("$or") {
        Ok(a) => a,
        Err(_) => return false,
    };
    if or_arr.len() != expected_vars.len() {
        return false;
    }
    // Every operand must be `{ $lte: ["$$<var>", { $literal: null }] }`
    // referencing some var from `expected_vars`. Order-independent set
    // equality is the correctness check (we already validate the
    // user-source order via the outer `$or`).
    let mut got: Vec<String> = Vec::with_capacity(or_arr.len());
    for op in or_arr {
        let opd = match op.as_document() {
            Some(d) => d,
            None => return false,
        };
        if opd.len() != 1 {
            return false;
        }
        let lte_arr = match opd.get_array("$lte") {
            Ok(a) => a,
            Err(_) => return false,
        };
        if lte_arr.len() != 2 {
            return false;
        }
        let var = match &lte_arr[0] {
            Bson::String(s) if s.starts_with("$$") => s[2..].to_string(),
            _ => return false,
        };
        if !is_literal_null(&lte_arr[1]) {
            return false;
        }
        got.push(var);
    }
    let mut got_sorted = got;
    got_sorted.sort();
    let mut expected_sorted: Vec<String> = expected_vars.to_vec();
    expected_sorted.sort();
    if got_sorted != expected_sorted {
        return false;
    }

    // Then-branch must be `{ $literal: null }`.
    if !is_literal_null(&arr[1]) {
        return false;
    }
    // Else-branch must be `{ $literal: false }`.
    if !is_literal_bool(&arr[2], false) {
        return false;
    }
    true
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

    // ----- $let-wrapped IN-list collapse (GROUP BY + IN shape) -----

    /// Build the verified mongosql v1.8.5 `$let`-wrapped IN-list shape
    /// for `source_field IN (values…)`. The inner per-operand `$let.vars`
    /// key is hardcoded to `desugared_sqlEq_input0` to match the real
    /// translator output; the outer slot keys are
    /// `desugared_sqlOr_input0..N-1`.
    ///
    /// `rhs_literal(i)` is invoked per operand to produce that
    /// operand's RHS literal Bson value (already-wrapped in
    /// `{$literal: x}` when appropriate). One helper drives every
    /// scenario (string literals, Decimal128, ObjectId, nested-field
    /// source, …).
    fn build_mongosql_in_list_let<F>(source_field: &str, n: usize, mut rhs_literal: F) -> Document
    where
        F: FnMut(usize) -> Bson,
    {
        let mut vars = Document::new();
        let mut outer_or_operands: Vec<Bson> = Vec::with_capacity(n);
        let mut inner_null_or_operands: Vec<Bson> = Vec::with_capacity(n);
        for i in 0..n {
            let var_name = format!("desugared_sqlOr_input{i}");
            vars.insert(
                var_name.clone(),
                doc! {
                    "$let": {
                        "vars": { "desugared_sqlEq_input0": source_field },
                        "in": {
                            "$cond": [
                                {
                                    "$lte": [
                                        "$$desugared_sqlEq_input0",
                                        { "$literal": Bson::Null },
                                    ],
                                },
                                { "$literal": Bson::Null },
                                {
                                    "$eq": [
                                        "$$desugared_sqlEq_input0",
                                        rhs_literal(i),
                                    ],
                                },
                            ],
                        },
                    },
                },
            );
            outer_or_operands.push(bson!({
                "$eq": [format!("$${var_name}"), { "$literal": true }],
            }));
            inner_null_or_operands.push(bson!({
                "$lte": [format!("$${var_name}"), { "$literal": Bson::Null }],
            }));
        }
        doc! {
            "$let": {
                "vars": vars,
                "in": {
                    "$cond": [
                        { "$or": Bson::Array(outer_or_operands) },
                        { "$literal": true },
                        {
                            "$cond": [
                                { "$or": Bson::Array(inner_null_or_operands) },
                                { "$literal": Bson::Null },
                                { "$literal": false },
                            ],
                        },
                    ],
                },
            },
        }
    }

    /// Extract the `$cond` array from a collapsed document; panic
    /// loudly when the shape is wrong so test failures point at the
    /// actual structural deviation.
    fn get_cond_array(d: &Document) -> &Vec<Bson> {
        match d.get("$cond") {
            Some(Bson::Array(a)) => a,
            _ => panic!("expected $cond array after collapse; got {d:?}"),
        }
    }

    /// Count occurrences of `key` in a Bson tree. Helper for pipeline-
    /// shape invariants in the large-N tests.
    fn count_key_in_bson(b: &Bson, key: &str) -> usize {
        match b {
            Bson::Document(d) => {
                let here = d.iter().filter(|(k, _)| k.as_str() == key).count();
                let child: usize = d.iter().map(|(_, v)| count_key_in_bson(v, key)).sum();
                here + child
            }
            Bson::Array(a) => a.iter().map(|v| count_key_in_bson(v, key)).sum(),
            _ => 0,
        }
    }

    #[test]
    fn collapse_mongosql_in_list_let_basic() {
        // Canonical N=3 case: outer $let with 3 desugared_sqlOr_input
        // vars, each binding `$agentId`, RHS literals "v0", "v1", "v2".
        let mut input =
            build_mongosql_in_list_let("$agentId", 3, |i| bson!({ "$literal": format!("v{i}") }));
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(fired, "collapse must fire on the canonical IN-list shape");
        assert!(!input.contains_key("$let"), "$let must be removed");
        let cond = get_cond_array(&input);
        assert_eq!(cond.len(), 3);
        // cond[0] is `{$lte: ["$agentId", {$literal: null}]}`.
        let lte_arr = cond[0].as_document().unwrap().get_array("$lte").unwrap();
        assert_eq!(lte_arr[0], Bson::String("$agentId".into()));
        assert!(is_literal_null(&lte_arr[1]));
        // cond[1] is `{$literal: null}`.
        assert!(is_literal_null(&cond[1]));
        // cond[2] is `{$in: ["$agentId", [...]]}`.
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        assert_eq!(in_arr[0], Bson::String("$agentId".into()));
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), 3);
        for (i, v) in vals.iter().enumerate() {
            // Safe non-`$`-prefixed strings are unwrapped from
            // `{$literal: "vN"}` to bare `"vN"` by `extract_literal` —
            // semantically identical because `$in` evaluates each
            // element as a value (a bare non-`$`-string is a string
            // literal).
            assert_eq!(v.as_str(), Some(format!("v{i}").as_str()));
        }
    }

    #[test]
    fn collapse_mongosql_in_list_let_161_elements_no_overflow() {
        // The exact user-reported failure size. Post-collapse the
        // pipeline must contain ZERO `$or`/`$let`, and exactly one `$in`
        // whose value array carries 161 literals in input order.
        let n = 161;
        let inner =
            build_mongosql_in_list_let("$agentId", n, |i| bson!({ "$literal": format!("v{i}") }));
        let mut pipeline = vec![doc! {
            "$match": { "$expr": Bson::Document(inner) },
        }];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);

        let or_total: usize = pipeline
            .iter()
            .map(|s| count_key_in_bson(&Bson::Document(s.clone()), "$or"))
            .sum();
        let in_total: usize = pipeline
            .iter()
            .map(|s| count_key_in_bson(&Bson::Document(s.clone()), "$in"))
            .sum();
        let let_total: usize = pipeline
            .iter()
            .map(|s| count_key_in_bson(&Bson::Document(s.clone()), "$let"))
            .sum();
        assert_eq!(or_total, 0, "all $or arrays must be eliminated");
        assert_eq!(in_total, 1, "exactly one $in must replace the IN-list");
        assert_eq!(let_total, 0, "no $let remains after collapse");

        let cond = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get_document("$expr")
            .unwrap()
            .get_array("$cond")
            .unwrap();
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), n);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_str(), Some(format!("v{i}").as_str()));
        }
    }

    #[test]
    fn collapse_mongosql_in_list_let_n_1000_no_stack_overflow() {
        // Stress test: 1000-element IN list. The collapse uses simple
        // iteration (no recursion proportional to N), so this must
        // finish quickly and produce a single `$in` of length 1000.
        let n = 1000;
        let mut input =
            build_mongosql_in_list_let("$agentId", n, |i| bson!({ "$literal": (i as i64) }));
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(fired);
        let cond = get_cond_array(&input);
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), n);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_i64(), Some(i as i64));
        }
    }

    #[test]
    fn collapse_mongosql_in_list_let_n_2_minimum() {
        // The minimum-viable N=2 shape — the conservative threshold is
        // 2 (single-element rejected by the `len() < 2` check).
        let mut input =
            build_mongosql_in_list_let("$agentId", 2, |i| bson!({ "$literal": format!("v{i}") }));
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(fired);
        let cond = get_cond_array(&input);
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), 2);
        assert_eq!(vals[0].as_str(), Some("v0"));
        assert_eq!(vals[1].as_str(), Some("v1"));
    }

    #[test]
    fn collapse_mongosql_in_list_let_skipped_different_fields() {
        // Operand 1 binds `$agentId`; we mutate operand 1's inner var
        // to bind `$callerId`. The same-source-field invariant must
        // fail and the collapse must abort, leaving the doc untouched.
        let mut input =
            build_mongosql_in_list_let("$agentId", 3, |i| bson!({ "$literal": format!("v{i}") }));
        if let Some(Bson::Document(let_doc)) = input.get_mut("$let") {
            if let Some(Bson::Document(vars)) = let_doc.get_mut("vars") {
                if let Some(Bson::Document(op1)) = vars.get_mut("desugared_sqlOr_input1") {
                    if let Some(Bson::Document(inner_let)) = op1.get_mut("$let") {
                        if let Some(Bson::Document(inner_vars)) = inner_let.get_mut("vars") {
                            inner_vars.insert("desugared_sqlEq_input0", "$callerId");
                        }
                    }
                }
            }
        }
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired, "must not collapse when source fields differ");
        assert_eq!(input, snapshot, "document must be byte-identical");
    }

    #[test]
    fn collapse_mongosql_in_list_let_skipped_non_literal_rhs() {
        // One operand's `$eq` RHS is a bare `$`-prefixed string (field
        // reference, not a literal). `extract_literal` rejects it →
        // the per-operand parse returns None → the collapse aborts.
        let mut input = build_mongosql_in_list_let("$agentId", 3, |i| {
            if i == 1 {
                Bson::String("$other_field".into())
            } else {
                bson!({ "$literal": format!("v{i}") })
            }
        });
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired, "must not collapse when an RHS is a field reference");
        assert_eq!(input, snapshot);
    }

    #[test]
    fn collapse_mongosql_in_list_let_skipped_null_handling_mismatch() {
        // Outer `else`-branch's `$or` operand uses a `$lt` (not `$lte`)
        // null check. The shape mismatch must abort the collapse.
        let mut input =
            build_mongosql_in_list_let("$agentId", 3, |i| bson!({ "$literal": format!("v{i}") }));
        if let Some(Bson::Document(let_doc)) = input.get_mut("$let") {
            if let Some(Bson::Document(in_doc)) = let_doc.get_mut("in") {
                if let Some(Bson::Array(outer_cond)) = in_doc.get_mut("$cond") {
                    if let Some(Bson::Document(inner_cond_doc)) = outer_cond.get_mut(2) {
                        if let Some(Bson::Array(inner_cond)) = inner_cond_doc.get_mut("$cond") {
                            if let Some(Bson::Document(if_doc)) = inner_cond.get_mut(0) {
                                if let Some(Bson::Array(or_arr)) = if_doc.get_mut("$or") {
                                    // Replace first $lte operand with a $lt operand.
                                    or_arr[0] = bson!({
                                        "$lt": [
                                            "$$desugared_sqlOr_input0",
                                            { "$literal": Bson::Null },
                                        ]
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired, "must not collapse when null-handling differs");
        assert_eq!(input, snapshot);
    }

    #[test]
    fn collapse_mongosql_in_list_let_skipped_for_single_var() {
        // N=1 is rejected by the `vars.len() < 2` precondition.
        let mut input =
            build_mongosql_in_list_let("$agentId", 1, |i| bson!({ "$literal": format!("v{i}") }));
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired, "single-var $let must NOT collapse (conservative)");
        assert_eq!(input, snapshot);
    }

    #[test]
    fn collapse_mongosql_in_list_let_skipped_missing_inner_cond_shape() {
        // Outer `$let.in` isn't the canonical 3-elem `$cond`. Reject.
        let mut input =
            build_mongosql_in_list_let("$agentId", 3, |i| bson!({ "$literal": format!("v{i}") }));
        if let Some(Bson::Document(let_doc)) = input.get_mut("$let") {
            let_doc.insert("in", bson!({ "$literal": true }));
        }
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired);
        assert_eq!(input, snapshot);
    }

    #[test]
    fn collapse_mongosql_in_list_let_skipped_missing_null_else_branch() {
        // Outer `$let.in.$cond[2]` isn't the inner null-prop `$cond`.
        // Reject — the semantics wouldn't be preserved otherwise.
        let mut input =
            build_mongosql_in_list_let("$agentId", 3, |i| bson!({ "$literal": format!("v{i}") }));
        if let Some(Bson::Document(let_doc)) = input.get_mut("$let") {
            if let Some(Bson::Document(in_doc)) = let_doc.get_mut("in") {
                if let Some(Bson::Array(cond)) = in_doc.get_mut("$cond") {
                    cond[2] = bson!({ "$literal": false });
                }
            }
        }
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired);
        assert_eq!(input, snapshot);
    }

    #[test]
    fn collapse_mongosql_in_list_let_preserves_literal_types() {
        // Mixed BSON scalar types — Decimal128, DateTime, ObjectId,
        // Int64. All must round-trip through the collapse byte-
        // identically. `extract_literal` unwraps safe scalar literals
        // (no `$`-prefix concern) → they appear bare in the value
        // array, preserving BSON type fidelity.
        let dec: Decimal128 = "123.456".parse().unwrap();
        let dt = DateTime::from_millis(1_700_000_000_000);
        let oid = ObjectId::new();
        let int = 42_i64;
        let rhs_values: Vec<Bson> = vec![
            bson!({ "$literal": dec }),
            bson!({ "$literal": Bson::DateTime(dt) }),
            bson!({ "$literal": Bson::ObjectId(oid) }),
            bson!({ "$literal": int }),
        ];
        let mut input =
            build_mongosql_in_list_let("$mixed", rhs_values.len(), |i| rhs_values[i].clone());
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(fired);
        let cond = get_cond_array(&input);
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), rhs_values.len());
        assert_eq!(vals[0], Bson::Decimal128(dec));
        assert_eq!(vals[1], Bson::DateTime(dt));
        assert_eq!(vals[2], Bson::ObjectId(oid));
        assert_eq!(vals[3], Bson::Int64(int));
    }

    #[test]
    fn collapse_mongosql_in_list_let_with_nested_field() {
        // Dotted source-field path survives the collapse verbatim.
        let source = "$evaluationResults.evaluations.callQuality.score";
        let mut input =
            build_mongosql_in_list_let(source, 5, |i| bson!({ "$literal": (i as i64) }));
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(fired);
        let cond = get_cond_array(&input);
        let lte_arr = cond[0].as_document().unwrap().get_array("$lte").unwrap();
        assert_eq!(lte_arr[0], Bson::String(source.into()));
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        assert_eq!(in_arr[0], Bson::String(source.into()));
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), 5);
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(v.as_i64(), Some(i as i64));
        }
    }

    #[test]
    fn collapse_mongosql_in_list_let_does_not_touch_unrelated_let() {
        // A `$let` with non-IN-list var names (e.g. for `BETWEEN` /
        // top-level `AND`) must NOT be collapsed. The
        // `SQL_OR_INPUT_PREFIX` check prevents false positives.
        let mut input = doc! {
            "$let": {
                "vars": {
                    "desugared_sqlAnd_input0": "$start_time",
                    "desugared_sqlAnd_input1": "$end_time",
                },
                "in": { "$cond": [{ "$literal": true }, "$start_time", "$end_time"] },
            },
        };
        let snapshot = input.clone();
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(!fired, "non-IN-list var-name prefix must NOT match");
        assert_eq!(input, snapshot);
    }

    #[test]
    fn collapse_mongosql_in_list_let_walks_nested_lets() {
        // The IN-list `$let` is nested INSIDE an outer `$let` (a
        // BETWEEN + IS NOT NULL + IN scenario). The walker must
        // descend and collapse ONLY the IN-list slot, leaving the
        // outer envelope intact.
        let in_list_let =
            build_mongosql_in_list_let("$agentId", 4, |i| bson!({ "$literal": format!("v{i}") }));
        let mut pipeline = vec![doc! {
            "$match": {
                "$expr": {
                    "$let": {
                        "vars": {
                            "desugared_sqlAnd_input0": "$callStartTime",
                            "desugared_sqlAnd_input1": "$callStartTime",
                        },
                        "in": {
                            "$and": [
                                { "$gte": ["$$desugared_sqlAnd_input0", { "$literal": "2024-01-01" }] },
                                { "$lte": ["$$desugared_sqlAnd_input1", { "$literal": "2024-12-31" }] },
                                Bson::Document(in_list_let),
                                { "$ne": ["$agentName", { "$literal": Bson::Null }] },
                            ],
                        },
                    },
                },
            },
        }];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);

        // Outer `$let` preserved (its var names don't match the
        // IN-list prefix and its `in` isn't a `$cond`).
        let outer_let = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get_document("$expr")
            .unwrap()
            .get_document("$let")
            .unwrap();
        let and_arr = outer_let
            .get_document("in")
            .unwrap()
            .get_array("$and")
            .unwrap();
        assert_eq!(and_arr.len(), 4);
        // Element 2 (the previously `$let`-wrapped IN list) became a
        // `$cond` with `$in`.
        let collapsed = and_arr[2].as_document().expect("inner doc");
        assert!(
            collapsed.contains_key("$cond") && !collapsed.contains_key("$let"),
            "nested IN-list $let must be collapsed; got {collapsed:?}",
        );
        let cond = collapsed.get_array("$cond").unwrap();
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), 4);
    }

    #[test]
    fn collapse_mongosql_in_list_let_var_order_preserved() {
        // The outer `$or` defines the user-source order. If the `$or`
        // operands are in non-trivial order (here: reversed), the
        // resulting `$in` value array must honour THAT order, not the
        // IndexMap iteration order of the outer `vars` map.
        let mut input =
            build_mongosql_in_list_let("$agentId", 5, |i| bson!({ "$literal": format!("v{i}") }));
        if let Some(Bson::Document(let_doc)) = input.get_mut("$let") {
            if let Some(Bson::Document(in_doc)) = let_doc.get_mut("in") {
                if let Some(Bson::Array(cond)) = in_doc.get_mut("$cond") {
                    if let Some(Bson::Document(if_doc)) = cond.get_mut(0) {
                        if let Some(Bson::Array(or_arr)) = if_doc.get_mut("$or") {
                            or_arr.reverse();
                        }
                    }
                }
            }
        }
        let fired = collapse_mongosql_in_list_let(&mut input);
        assert!(fired);
        let cond = get_cond_array(&input);
        let in_arr = cond[2].as_document().unwrap().get_array("$in").unwrap();
        let vals = in_arr[1].as_array().unwrap();
        assert_eq!(vals.len(), 5);
        // Expect reversed-order values: v4, v3, v2, v1, v0.
        for (i, v) in vals.iter().enumerate() {
            let want = format!("v{}", 4 - i);
            assert_eq!(v.as_str(), Some(want.as_str()));
        }
    }

    #[test]
    fn collapse_mongosql_in_list_let_inside_full_pipeline() {
        // End-to-end inside a 3-stage pipeline that mirrors the
        // user-reported shape ($match.$expr → $group → $limit).
        let in_list =
            build_mongosql_in_list_let("$agentId", 161, |i| bson!({ "$literal": format!("v{i}") }));
        let mut pipeline = vec![
            doc! { "$match": { "$expr": Bson::Document(in_list) } },
            doc! { "$group": { "_id": "$agentName", "_agg1": { "$sum": { "$literal": 1_i64 } } } },
            doc! { "$limit": 30_i64 },
        ];
        flatten_or_chains_and_collapse_to_in(&mut pipeline);
        let expr = pipeline[0]
            .get_document("$match")
            .unwrap()
            .get_document("$expr")
            .unwrap();
        assert!(expr.contains_key("$cond"));
        assert!(!expr.contains_key("$let"));
        assert!(pipeline[1].contains_key("$group"));
        assert!(pipeline[2].contains_key("$limit"));
    }
}

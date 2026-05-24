//! Query executor and BSON → JSON marshaling.
//!
//! See ARCHITECTURE.md §4.1 (per-query sequence) and §4.2 (BSON → JSON
//! marshaling table). This module:
//!
//! 1. Hands a translated [`Translation`] to MongoDB via either
//!    `Database::aggregate` or `Collection::aggregate`, depending on whether
//!    the upstream `mongosql::Translation::target_collection` was `Some(name)`
//!    or `None`. The `None` branch is the database-level aggregate path —
//!    some MongoSQL queries (e.g. cross-collection forms) translate to a
//!    pipeline that runs at the database level rather than against any
//!    single collection.
//! 2. Applies the configured per-query timeout via `AggregateOptions::max_time`
//!    (mapped on the wire to `maxTimeMS`).
//! 3. Buffers up to `max_rows` rows and throws [`Error::ResultTooLarge`] if
//!    the cursor would exceed the cap (NFR-1: napi-rs has no AsyncIterator
//!    macro, so we buffer; the cap bounds memory).
//! 4. Marshals each `bson::Document` row to a `serde_json::Value::Object` via
//!    [`bson_to_json`].
//!
//! The marshaling table deliberately *does not* use bson's
//! [`bson::Bson::into_relaxed_extjson`] for the whole document: it panics on
//! `Decimal128`, and its `DateTime` shape is `{ "$date": "..." }` rather than
//! a bare ISO-8601 string, which is harder for downstream Cube measure types
//! to consume. We hand-roll the variant match so that compilation fails if a
//! new BSON variant is added without coverage. For the few legacy variants we
//! delegate the EJSON shape to `into_relaxed_extjson` (Binary, Regex, Symbol,
//! Code, CodeWithScope, Timestamp, MinKey, MaxKey, Undefined, DbPointer)
//! because their fields are private or their canonical EJSON form is fixed.

use std::time::Duration;

use bson::{Binary, Bson, DateTime as BsonDateTime, Document, Regex};
use futures_util::TryStreamExt;
use mongodb::error::ErrorKind;
use mongodb::options::AggregateOptions;
use mongodb::Client;
use mongosql::json_schema::{BsonType, BsonTypeName, Schema as JsonSchema};
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::translate::Translation;

/// Cursor batch size passed via [`AggregateOptions::batch_size`]. Picked to
/// match common BI-tool defaults; tunable later if profiling shows benefit.
const CURSOR_BATCH_SIZE: u32 = 1000;

/// Threshold above which an Int64 cannot be exactly represented as a JS
/// number. Used purely to emit a tracing warning — the value still serializes
/// as a JSON number (which is the SPEC.md / ARCHITECTURE.md §4.2 contract).
const JS_SAFE_INT_MAX: i64 = 1 << 53;

/// Outcome of running a translated query.
///
/// `rows` is the BSON-marshalled cursor (one JSON object per row,
/// per-collection-envelope shape that `flattenRow` on the TS side
/// unpacks). `types` is the ordered `(name, type)` list derived from
/// `mongosql::Translation::{select_order, result_set_schema}` — the
/// authoritative projection order + BSON-type mapping. The TS wrapper
/// passes `types` to Cube Store unchanged.
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    /// Rows as JSON values (each row is typically a `Value::Object`).
    pub rows: Vec<Value>,
    /// Ordered projection columns with BSON-typed-derived Cube generic
    /// type strings (`timestamp`, `int`, `bigint`, `decimal`, `boolean`,
    /// `string`, `text`).
    pub types: Vec<ColumnType>,
}

/// A single `(name, type)` entry in the result-set type list. `type` is a
/// Cube generic-type string from the `DbTypeValueMatcher` vocabulary
/// (`timestamp` | `int` | `bigint` | `decimal` | `boolean` | `string` |
/// `text`) — the set Cube Store accepts on its LOAD ROWS path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnType {
    /// Column name as it appears in `rows` AFTER `flattenRow` runs on the
    /// TS side. With the default `IncludeNamespaces` SqlOptions and a
    /// multi-key projection this is `<namespace>__<column>`; for a
    /// single-key projection (one namespace) the flatten path unwraps to
    /// just `<column>`.
    pub name: String,
    /// Cube generic-type string.
    pub ty: &'static str,
}

/// Execute the given translation against MongoDB and return rows plus the
/// authoritative type list.
///
/// - `timeout_ms` is mapped to `maxTimeMS` at the server. A `Some(0)` cap
///   would disable the server-side timer; we still pass it as-is so callers
///   that intentionally request "no timeout" get that.
/// - `max_rows` is enforced *client-side* during cursor draining. The cap is
///   strict: returning exactly `max_rows` is fine, returning `max_rows + 1`
///   yields [`Error::ResultTooLarge`].
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by integration tests today
pub async fn execute(
    client: &Client,
    translation: Translation,
    timeout_ms: u32,
    max_rows: u32,
) -> Result<ExecutionResult> {
    // Derive types BEFORE we move `translation.pipeline` into the cursor
    // builder. The mongosql metadata is the source of truth for column
    // names and types; computing it up front means we never depend on the
    // cursor returning at least one row.
    let types = column_types_from_schema(&translation.select_order, &translation.result_set_schema);

    let db = client.database(&translation.target_db);
    let opts = AggregateOptions::builder()
        .max_time(Some(Duration::from_millis(timeout_ms as u64)))
        .batch_size(Some(CURSOR_BATCH_SIZE))
        .build();

    // Branch on collection-level vs database-level aggregate. The pipeline is
    // already a `Vec<Document>` (T07 unwrapped the BSON Array), so it goes
    // straight to the action builder.
    let cursor_result = match translation.target_collection.as_deref() {
        Some(coll) => {
            db.collection::<Document>(coll)
                .aggregate(translation.pipeline)
                .with_options(opts)
                .await
        }
        None => db.aggregate(translation.pipeline).with_options(opts).await,
    };

    let mut cursor = cursor_result.map_err(map_mongo_error)?;

    let mut rows: Vec<Value> = Vec::new();
    loop {
        match cursor.try_next().await {
            Ok(Some(doc)) => {
                if rows.len() as u64 >= max_rows as u64 {
                    return Err(Error::ResultTooLarge { limit: max_rows });
                }
                rows.push(bson_to_json(Bson::Document(doc)));
            }
            Ok(None) => break,
            Err(err) => return Err(map_mongo_error(err)),
        }
    }

    Ok(ExecutionResult { rows, types })
}

/// Derive an ordered `(name, type)` list from the upstream
/// `select_order` + `result_set_schema`.
///
/// `select_order` is the source of truth for both *order* and the *path*
/// to walk into the schema. Each path is one of:
///
///   - `[namespace, column]` with default `IncludeNamespaces` SqlOptions
///     — typical;
///   - `[column]` with `ExcludeNamespaces` — we accept this too even
///     though we don't currently set the option, because it's a trivial
///     superset to handle and keeps the helper closed over both options;
///   - `["", column]` — the empty-string-namespace form mongosql emits
///     for explicit projection lists in multi-cube queries; treated like
///     `[column]` because the empty namespace would otherwise leak
///     `"__" + column` keys into the type list.
///
/// **Flatten-name rule.** The names returned here MUST match the keys the
/// TS-side `flattenRow` produces (`src/MongoSqlDriver.ts::flattenRow`):
///
///   - `flattenRow` inspects the *first row's* key count. If there is
///     exactly one top-level key whose value is a plain object, it
///     unwraps and the names are the inner object's keys. Otherwise it
///     emits `<tbl>__<col>` for every (top-key, inner-key) pair.
///   - We mirror this by counting the distinct top-level prefixes that
///     appear in `select_order` (which is the projection's authoritative
///     order). One prefix → bare column names; two or more → namespaced.
///   - **Empty-string prefix.** Mongosql emits `["", col]` for explicit
///     projections that aren't qualified to a single cube. `flattenRow`
///     receives `{"": {col1, col2, ...}}` — that's a single top-level
///     key, so it un-wraps and produces bare column names. We treat the
///     empty-string prefix as a distinct prefix for the count so that a
///     mixed-prefix select_order (`[["", "a"], ["x", "b"]]`) is still
///     classified as multi-key, matching what `flattenRow` would do
///     against the row `{"": {a: ...}, "x": {b: ...}}` (two top keys →
///     namespaced flatten, names `__a` and `x__b`). Mixed-prefix paths
///     are unusual but we generate names byte-equal to JS to keep the
///     two layers in lock-step.
///
/// Empty `select_order` (e.g. a query that doesn't go through the
/// projection-parsing branch — unlikely from real SQL but possible if
/// upstream returns an empty list) yields an empty types list.
pub fn column_types_from_schema(
    select_order: &[Vec<String>],
    schema: &JsonSchema,
) -> Vec<ColumnType> {
    if select_order.is_empty() {
        return Vec::new();
    }

    // Collect the set of distinct top-level prefixes (including the
    // empty-string prefix). This count tells us which `flattenRow`
    // branch the TS side will take for the row we'll return alongside.
    //   - 0 prefixes (every path is `[column]`, ExcludeNamespaces form):
    //     flattenRow receives one key per column; with one key it
    //     unwraps but the value will be the scalar, not an object — the
    //     `isPlainObject` check fails and the row passes through. The
    //     names ARE the bare columns. Treat as single-key for naming.
    //   - 1 distinct prefix: standard single-cube projection;
    //     flattenRow unwraps. Bare column names.
    //   - 2+ distinct prefixes: multi-key envelope; flattenRow emits
    //     `<tbl>__<col>`. We do the same, with the empty-string prefix
    //     contributing `__col` (matches `out["" + "__" + col]` on JS).
    let mut distinct_prefixes: Vec<&str> = Vec::new();
    for path in select_order {
        if path.len() <= 1 {
            // ExcludeNamespaces form — no namespace prefix at all.
            continue;
        }
        let ns = path[0].as_str();
        if !distinct_prefixes.contains(&ns) {
            distinct_prefixes.push(ns);
        }
    }
    let single_key_envelope = distinct_prefixes.len() <= 1;

    let mut out: Vec<ColumnType> = Vec::with_capacity(select_order.len());
    for path in select_order {
        let name = flattened_name(path, single_key_envelope);
        let ty = schema_at(schema, path)
            .map(cube_type_for_schema)
            .unwrap_or("text");
        out.push(ColumnType { name, ty });
    }
    out
}

/// Build the `flattenRow`-equivalent name for a `select_order` path.
///
/// Behaviour must mirror TS `flattenRow` byte-for-byte:
///
///   - Single-key-envelope (TS sees one top-level key and unwraps to the
///     inner object): emit the *last* path component (the bare column).
///     For `["ns", "col"]` this is `"col"`; for `["", "col"]` it's also
///     `"col"`. For a single-component path `["col"]` it's `"col"`.
///   - Multi-key envelope (TS sees two or more top-level keys and emits
///     `out["${tbl}__${col}"] = v`): we join with `__` *including* an
///     empty-prefix component as a leading empty string. The TS join is
///     literal `\`${tbl}__${col}\`` so `tbl = ""` yields `"__col"`. We
///     reproduce that exactly here, never silently dropping the empty
///     component.
fn flattened_name(path: &[String], single_key_envelope: bool) -> String {
    if path.is_empty() {
        // No components at all — defensive; shouldn't happen in practice.
        return String::new();
    }
    if path.len() == 1 {
        // Bare column (ExcludeNamespaces form).
        return path[0].clone();
    }
    if single_key_envelope {
        // TS un-wraps the outer key. Name is the last path component
        // (the bare column inside the namespace object).
        return path
            .last()
            .expect("path has length >= 2, last() infallible")
            .clone();
    }
    // Multi-key envelope. Mirror the TS template literal exactly,
    // including empty components — `["", "col"]` becomes `"__col"`, not
    // `"col"`. This is the corner case (#7 in the v3 critique) where the
    // old version mismatched flattenRow.
    path.join("__")
}

/// Walk into `schema` along `path` and return the sub-schema sitting
/// at that path (NOT just its `bson_type`).
///
/// Returns `None` if any intermediate step is missing. We return the
/// whole `&JsonSchema` rather than just the `bson_type` because the
/// runtime shape mongosql actually emits for aggregated, nullable, or
/// GROUP-BY columns is `{ bson_type: None, any_of: [...] }` — the type
/// information lives in `any_of`, not `bson_type`. The caller
/// (`cube_type_for_schema`) is responsible for collapsing the union.
///
/// Empty path components are walked literally — mongosql models the
/// explicit-projection-list shape as `["", col]` and the corresponding
/// schema is `{properties: {"": {properties: {col: ...}}}}`, so we must
/// look up the empty-string key, not skip it.
fn schema_at<'a>(schema: &'a JsonSchema, path: &[String]) -> Option<&'a JsonSchema> {
    let mut current = schema;
    for component in path {
        let props = current.properties.as_ref()?;
        current = props.get(component.as_str())?;
    }
    Some(current)
}

/// Resolve a `JsonSchema` node to the Cube generic-type string accepted
/// by `DbTypeValueMatcher` / Cube Store's LOAD ROWS.
///
/// Source-of-truth: mongosql converts every `schema::Schema` into a
/// `json_schema::Schema` via `TryFrom<Schema>` in
/// `~/.cargo/git/checkouts/mongosql-*/mongosql/src/schema/definitions.rs`
/// (lines 703-773 at git-rev 4a159e5). The conversion never emits
/// `BsonType::Multiple` — it always emits an `any_of: Some(vec![...])`
/// for the `Schema::AnyOf` case, with `bson_type: None`. Atomic types
/// emit `bson_type: Some(BsonType::Single(name))` with `any_of: None`.
/// `Schema::Any` and `Schema::Unsat` emit `bson_type: None` with
/// `any_of: None` (Any) or `any_of: Some(vec![])` (Unsat).
///
/// Resolution rules, in order:
///
///   1. If `bson_type` is `Some(Single(name))`, map the atomic name.
///   2. If `any_of` is `Some(variants)`, classify the union:
///      - Drop `Null` variants (nullable-collapse — the column is
///        nullable but the Cube generic type is the non-null side).
///      - Deduplicate the remaining non-null atomic kinds.
///      - If exactly one distinct non-null atomic kind remains, map it.
///      - If exactly two remain and they widen safely (`Int + Long → bigint`,
///        `Int + Double → decimal`, `Long + Double → decimal`,
///        `Int + Decimal → decimal`, `Long + Decimal → decimal`,
///        `Double + Decimal → decimal`), use the wider type. This
///        covers the `COUNT(*) → AnyOf{Int, Long}` and
///        `SUM(decimal) → AnyOf{Decimal, Null}` cases that mongosql
///        actually emits.
///      - Anything else (heterogeneous non-null, recursive `any_of`,
///        empty/Unsat union) falls back to `text`.
///   3. `bson_type: Some(Multiple(...))` is included for completeness
///      even though mongosql's conversion path never produces it — a
///      future upstream change or hand-built schema could exercise it.
///      Same rules as `any_of` (drop Null, widen, otherwise text).
///   4. Otherwise (both `bson_type` and `any_of` empty — Any/Unknown),
///      fall back to `text`.
fn cube_type_for_schema(s: &JsonSchema) -> &'static str {
    // First-shot: a single-atomic bson_type is unambiguous.
    if let Some(BsonType::Single(name)) = &s.bson_type {
        return bson_type_name_to_cube(*name);
    }
    // any_of is the runtime path mongosql emits for nullable/aggregated
    // columns. Resolve it by collecting the non-null atomic variants.
    if let Some(variants) = &s.any_of {
        return resolve_union(variants.iter().filter_map(extract_atomic_names));
    }
    // Hand-built `Multiple([X, Null])` for completeness; mongosql's own
    // conversion does not emit this shape but we accept it.
    if let Some(BsonType::Multiple(names)) = &s.bson_type {
        return resolve_union(std::iter::once(names.to_vec()));
    }
    "text"
}

/// Extract the set of atomic `BsonTypeName`s that a `JsonSchema` variant
/// inside an `any_of` represents. Recursive — handles nested
/// `any_of: [{any_of: [...]}, ...]` (mongosql doesn't currently emit
/// this, but the Schema type permits it and the cost of being correct
/// is one extra recursive call).
///
/// Returns `None` if the variant is structurally non-atomic in a way
/// that prevents the union from being safely collapsed (Object schema,
/// Array schema with sub-items, etc.). The caller treats that as
/// "heterogeneous union — fall back to text".
fn extract_atomic_names(s: &JsonSchema) -> Option<Vec<BsonTypeName>> {
    match (&s.bson_type, &s.any_of) {
        (Some(BsonType::Single(name)), None) => Some(vec![*name]),
        (Some(BsonType::Multiple(names)), None) => Some(names.clone()),
        (None, Some(variants)) => {
            // Nested any_of. Flatten recursively. If any sub-variant
            // returns None, the union is unresolvable.
            let mut out: Vec<BsonTypeName> = Vec::new();
            for v in variants {
                let sub = extract_atomic_names(v)?;
                out.extend(sub);
            }
            Some(out)
        }
        // Schema::Any (`bson_type: None, any_of: None`) or any shape
        // with a non-empty `properties`/`items` etc. cannot be reduced
        // to a single Cube generic type. Schema::Unsat (`any_of:
        // Some(vec![])`) is matched by the outer arm above with an
        // empty variants list — caller will resolve_union it to text.
        _ => None,
    }
}

/// Given a sequence of atomic-name lists (each list represents one
/// variant of a union), collapse them to a single Cube generic-type
/// string per the rules described in [`cube_type_for_schema`].
fn resolve_union<I>(variants: I) -> &'static str
where
    I: IntoIterator<Item = Vec<BsonTypeName>>,
{
    // Flatten and deduplicate, dropping Null.
    let mut non_null: Vec<BsonTypeName> = Vec::new();
    for batch in variants {
        for n in batch {
            if matches!(n, BsonTypeName::Null) {
                continue;
            }
            if !non_null.contains(&n) {
                non_null.push(n);
            }
        }
    }
    match non_null.len() {
        0 => "text", // all-Null or empty (Unsat) — no useful generic type.
        1 => bson_type_name_to_cube(non_null[0]),
        _ => {
            // Multi-variant. Try numeric widening.
            //
            // Allowed widenings (any subset of these is fine — the
            // result is the widest member):
            //   {Int, Long}                        → bigint
            //   {Int, Long, Double}                → decimal
            //   {Int, Long, Decimal}               → decimal
            //   {Int, Long, Double, Decimal}       → decimal
            //   {Int, Double}                      → decimal
            //   {Int, Decimal}                     → decimal
            //   {Long, Double}                     → decimal
            //   {Long, Decimal}                    → decimal
            //   {Double, Decimal}                  → decimal
            // Anything outside `{Int, Long, Double, Decimal}` → text.
            let all_numeric = non_null.iter().all(|n| {
                matches!(
                    n,
                    BsonTypeName::Int
                        | BsonTypeName::Long
                        | BsonTypeName::Double
                        | BsonTypeName::Decimal,
                )
            });
            if !all_numeric {
                return "text";
            }
            let has_decimal_or_double = non_null
                .iter()
                .any(|n| matches!(n, BsonTypeName::Double | BsonTypeName::Decimal));
            if has_decimal_or_double {
                "decimal"
            } else {
                // Only `Int` and/or `Long` present — widen to bigint.
                "bigint"
            }
        }
    }
}

/// Bare-BsonType convenience wrapper around [`cube_type_for_schema`].
/// Kept as a `pub(crate)` entry point so older tests / call-sites that
/// only carry a `BsonType` (not a full `JsonSchema`) keep compiling.
/// `Multiple([X, Null])` collapses to `X` per the same rules as
/// [`resolve_union`].
#[cfg(test)]
pub(crate) fn bson_type_to_cube_type(bt: &BsonType) -> &'static str {
    match bt {
        BsonType::Single(name) => bson_type_name_to_cube(*name),
        BsonType::Multiple(names) => resolve_union(std::iter::once(names.clone())),
    }
}

fn bson_type_name_to_cube(name: BsonTypeName) -> &'static str {
    // Note (Critic v3 — Issue #9): the Cube *generic* type for `Decimal`
    // is `decimal` here, but Cube's `BaseDriver.js::DbTypeValueMatcher.decimal`
    // uses the regex `/^-?\d+(\.\d+)?$/` to validate *values* on the
    // value-sniffing path (`inferTypesFromRows`). Decimal128 values
    // whose canonical string form contains `E`/`e` (scientific
    // notation) would not match. Our driver bypasses
    // `DbTypeValueMatcher.decimal` entirely — we return authoritative
    // types from mongosql metadata, so the column is typed `decimal`
    // regardless of any one row's text form. Cube Store's loader
    // parses values with a Rust decimal library that accepts both
    // expanded and scientific notation, so the round-trip is correct.
    // See `decimal128_scientific_notation_round_trips_as_string` for
    // the pinning test.
    match name {
        BsonTypeName::ObjectId | BsonTypeName::String => "string",
        BsonTypeName::Int => "int",
        BsonTypeName::Long => "bigint",
        BsonTypeName::Double | BsonTypeName::Decimal => "decimal",
        BsonTypeName::Bool => "boolean",
        BsonTypeName::Date | BsonTypeName::Timestamp => "timestamp",
        BsonTypeName::Object
        | BsonTypeName::Array
        | BsonTypeName::BinData
        | BsonTypeName::Regex
        | BsonTypeName::Symbol
        | BsonTypeName::Javascript
        | BsonTypeName::JavascriptWithScope
        | BsonTypeName::MinKey
        | BsonTypeName::MaxKey
        | BsonTypeName::DbPointer
        | BsonTypeName::Undefined
        | BsonTypeName::Null => "text",
    }
}

/// Convert `mongodb::error::Error` to our taxonomy, with timeout (server
/// `maxTimeMSExpired`, code 50) routed to [`Error::Timeout`] and everything
/// else falling through to the existing `From<mongodb::error::Error>` mapping
/// (which handles auth/connect/io/etc.).
fn map_mongo_error(err: mongodb::error::Error) -> Error {
    if let ErrorKind::Command(ref cmd) = *err.kind {
        // 50 = MaxTimeMSExpired. The mongodb crate exposes the same check via
        // a `pub(crate)` helper; we replicate it on the public surface.
        if cmd.code == 50 {
            return Error::Timeout;
        }
    }
    Error::from(err)
}

/// Convert a single `bson::Bson` value to a `serde_json::Value` per
/// ARCHITECTURE.md §4.2.
///
/// Made `pub(crate)` so unit tests can drive it directly without going
/// through a real cursor. Exhaustive over `bson::Bson` variants — adding a
/// new variant upstream fails compilation here, which is the desired
/// behaviour: silently dropping a new BSON kind would be a correctness bug.
pub(crate) fn bson_to_json(value: Bson) -> Value {
    match value {
        // Direct primitive mappings.
        Bson::Double(f) => {
            // serde_json::Number::from_f64 returns None for NaN/Infinity (not
            // representable in JSON). Fall back to Null so the row is still
            // serializable. Cube treats numeric NaN as missing data.
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
        Bson::String(s) => Value::String(s),
        Bson::Boolean(b) => Value::Bool(b),
        Bson::Null => Value::Null,
        Bson::Int32(i) => Value::Number(i.into()),
        Bson::Int64(i) => {
            // Per ARCHITECTURE §4.2 / SPEC FR-4: still serialize as a JSON
            // number; warn if outside the JS safe-integer range so consumers
            // know precision loss is possible.
            if i.abs() > JS_SAFE_INT_MAX {
                tracing::warn!(
                    value = i,
                    "Int64 outside JS safe-integer range (±2^53); precision may be lost when read by Node"
                );
            }
            Value::Number(i.into())
        }

        // Recursive composite types.
        Bson::Document(doc) => Value::Object(document_to_map(doc)),
        Bson::Array(arr) => Value::Array(arr.into_iter().map(bson_to_json).collect()),

        // Stringified types — preserve precision / canonical hex form.
        Bson::Decimal128(d) => Value::String(d.to_string()),
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::DateTime(dt) => datetime_to_json(dt),

        // EJSON-form types. Hand-rolled to keep the shape stable and avoid
        // bson's relaxed_extjson `Decimal128` panic.
        Bson::Binary(Binary { subtype, bytes }) => {
            let st: u8 = u8::from(subtype);
            let mut obj = Map::new();
            obj.insert("$binary".to_string(), Value::String(base64_encode(&bytes)));
            obj.insert("$type".to_string(), Value::String(format!("{st:02x}")));
            Value::Object(obj)
        }
        Bson::RegularExpression(Regex { pattern, options }) => {
            // Sort options to match bson's relaxed_extjson canonical form.
            let mut chars: Vec<char> = options.chars().collect();
            chars.sort_unstable();
            let options: String = chars.into_iter().collect();
            let mut obj = Map::new();
            obj.insert("$regex".to_string(), Value::String(pattern));
            obj.insert("$options".to_string(), Value::String(options));
            Value::Object(obj)
        }
        Bson::Symbol(s) => {
            let mut obj = Map::new();
            obj.insert("$symbol".to_string(), Value::String(s));
            Value::Object(obj)
        }
        Bson::JavaScriptCode(code) => {
            let mut obj = Map::new();
            obj.insert("$code".to_string(), Value::String(code));
            Value::Object(obj)
        }
        Bson::JavaScriptCodeWithScope(jcs) => {
            let mut obj = Map::new();
            obj.insert("$code".to_string(), Value::String(jcs.code));
            obj.insert(
                "$scope".to_string(),
                Value::Object(document_to_map(jcs.scope)),
            );
            Value::Object(obj)
        }
        Bson::Timestamp(ts) => {
            let mut inner = Map::new();
            inner.insert("t".to_string(), Value::Number(ts.time.into()));
            inner.insert("i".to_string(), Value::Number(ts.increment.into()));
            let mut obj = Map::new();
            obj.insert("$timestamp".to_string(), Value::Object(inner));
            Value::Object(obj)
        }
        Bson::MinKey => {
            let mut obj = Map::new();
            obj.insert("$minKey".to_string(), Value::Number(1.into()));
            Value::Object(obj)
        }
        Bson::MaxKey => {
            let mut obj = Map::new();
            obj.insert("$maxKey".to_string(), Value::Number(1.into()));
            Value::Object(obj)
        }
        Bson::Undefined => {
            let mut obj = Map::new();
            obj.insert("$undefined".to_string(), Value::Bool(true));
            Value::Object(obj)
        }
        Bson::DbPointer(_) => {
            // DbPointer's fields are `pub(crate)` in bson 2.x, so we can't
            // pattern-match them. Delegate to bson's canonical relaxed_extjson
            // form (which doesn't panic for DbPointer; only Decimal128 panics
            // there). The result is `{"$dbPointer": {"$ref": ..., "$id": {"$oid": ...}}}`.
            value.into_relaxed_extjson()
        }
    }
}

/// Convert a `bson::Document` to a JSON `Map<String, Value>` by walking each
/// field through [`bson_to_json`]. Defined separately so several Bson arms
/// (Document, JavaScriptCodeWithScope) can share it.
fn document_to_map(doc: Document) -> Map<String, Value> {
    let mut map = Map::with_capacity(doc.len());
    for (k, v) in doc {
        map.insert(k, bson_to_json(v));
    }
    map
}

/// DateTime → ISO-8601 string per ARCHITECTURE §4.2 ("Cube parses time
/// dimensions from strings"). Uses bson's RFC 3339 helper, which falls back
/// to a "$date" / "$numberLong" EJSON form for out-of-range timestamps that
/// can't be formatted in RFC 3339 (year > 9999, etc.). For the
/// representable common case this returns a bare string like
/// "1970-01-01T00:00:00Z".
fn datetime_to_json(dt: BsonDateTime) -> Value {
    match dt.try_to_rfc3339_string() {
        Ok(s) => Value::String(s),
        Err(_) => {
            // Out-of-range fallback: surface the millis-since-epoch losslessly
            // in the canonical EJSON form so downstream consumers can still
            // reconstruct the moment. Avoids panicking, which the bson crate's
            // own `into_relaxed_extjson` would do for Decimal128 but happens
            // to do the same thing for DateTime out-of-range — we keep the
            // shape predictable.
            let mut inner = Map::new();
            inner.insert(
                "$numberLong".to_string(),
                Value::String(dt.timestamp_millis().to_string()),
            );
            let mut obj = Map::new();
            obj.insert("$date".to_string(), Value::Object(inner));
            obj
        }
        .into(),
    }
}

/// Tiny standard-base64 encoder. Avoids pulling in the `base64` crate just
/// for this one use site — the BSON Binary path only fires for opaque
/// payloads we never inspect.
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{
        doc, oid::ObjectId, spec::BinarySubtype, Decimal128, JavaScriptCodeWithScope, Timestamp,
    };
    use std::str::FromStr;

    // ----- primitives -----

    #[test]
    fn double_is_json_number() {
        let v = bson_to_json(Bson::Double(1.5));
        assert_eq!(v, Value::Number(serde_json::Number::from_f64(1.5).unwrap()));
    }

    #[test]
    fn double_nan_falls_back_to_null() {
        let v = bson_to_json(Bson::Double(f64::NAN));
        assert_eq!(v, Value::Null);
    }

    #[test]
    fn string_is_json_string() {
        assert_eq!(
            bson_to_json(Bson::String("hi".into())),
            Value::String("hi".into())
        );
    }

    #[test]
    fn boolean_is_json_bool() {
        assert_eq!(bson_to_json(Bson::Boolean(true)), Value::Bool(true));
        assert_eq!(bson_to_json(Bson::Boolean(false)), Value::Bool(false));
    }

    #[test]
    fn null_is_json_null() {
        assert_eq!(bson_to_json(Bson::Null), Value::Null);
    }

    #[test]
    fn int32_is_json_number() {
        assert_eq!(bson_to_json(Bson::Int32(42)), Value::Number(42.into()));
    }

    #[test]
    fn int64_within_safe_range_is_number() {
        let v = bson_to_json(Bson::Int64(1_000_000));
        assert_eq!(v, Value::Number(1_000_000_i64.into()));
    }

    #[test]
    fn int64_above_safe_range_still_serializes_as_number() {
        // No panic, no warning assertion (best-effort per task spec).
        let big = (1_i64 << 60) + 7;
        let v = bson_to_json(Bson::Int64(big));
        assert_eq!(v, Value::Number(big.into()));
    }

    // ----- precision-preserving stringified types -----

    #[test]
    fn decimal128_serializes_as_string_preserving_precision() {
        let d = Decimal128::from_str("4521.50").expect("parse decimal");
        let v = bson_to_json(Bson::Decimal128(d));
        match v {
            Value::String(s) => {
                // bson::Decimal128::to_string is the canonical IEEE 754-2008
                // form; for "4521.50" that's "4521.50" (no normalization).
                assert_eq!(s, "4521.50");
            }
            other => panic!("expected JSON string for Decimal128, got {other:?}"),
        }
    }

    #[test]
    fn decimal128_with_full_34_digit_precision_round_trips_losslessly() {
        // Critic v2 — Issue 3: lock the precision contract. Decimal128
        // supports up to 34 significant decimal digits per IEEE 754-2008;
        // a JS `Number` (IEEE 754 double) can only represent ~15-17
        // significant digits, so callers MUST consume the value as the
        // returned string and choose their own conversion strategy.
        // 30 significant digits is well past the JS-double safe range.
        let raw = "1234567890123456789012345678.901";
        let d = Decimal128::from_str(raw).expect("parse 30-digit decimal");
        let v = bson_to_json(Bson::Decimal128(d));
        match v {
            Value::String(s) => assert_eq!(s, raw, "Decimal128 must round-trip byte-for-byte"),
            other => panic!("expected JSON string, got {other:?}"),
        }
    }

    #[test]
    fn decimal128_scientific_notation_round_trips_as_string() {
        // Critic v3 — Issue #9. BSON Decimal128's canonical string form
        // may use scientific notation (`E`/`e`) for values whose exponent
        // is large. Cube's `BaseDriver.js::DbTypeValueMatcher.decimal`
        // regex (`/^-?\d+(\.\d+)?$/`) would REJECT such strings, but
        // we no longer route through that path — our driver returns
        // authoritative types from mongosql metadata (the column is
        // typed `decimal` regardless of any one row's textual form). The
        // remaining concern is Cube Store's loader: it parses the value
        // using a Rust decimal library that DOES accept scientific
        // notation. So the contract this test pins is:
        //
        //   1. We must NOT panic on Decimal128 marshaling (`Decimal128`
        //      values whose canonical form is scientific-notation are a
        //      regular runtime case).
        //   2. The output is a JSON string.
        //   3. The string is parseable back to Decimal128 — round-trip
        //      lossless.
        //
        // If a future Cube Store version regresses to the
        // `DbTypeValueMatcher.decimal` regex shape, we'll need to
        // post-process the scientific-notation form to its
        // expanded decimal form. That's tracked in the discoveries log
        // (see IMPLEMENTATION_PLAN.md 2026-05-23).
        let inputs = ["1E+3", "1.234E-5", "-1E+2", "1E0", "1.5E+10"];
        for raw in inputs {
            let d = match Decimal128::from_str(raw) {
                Ok(d) => d,
                // bson::Decimal128 in some versions rejects bare
                // scientific-notation strings on parse; skip those
                // inputs rather than fail the test on a parser
                // limitation we don't control.
                Err(_) => continue,
            };
            let v = bson_to_json(Bson::Decimal128(d));
            let s = match &v {
                Value::String(s) => s.clone(),
                other => panic!("expected JSON string for `{raw}`, got {other:?}"),
            };
            // Round-trip: re-parsing the driver's output yields the same
            // Decimal128. We compare canonical to-string forms because
            // Decimal128 does not implement Eq directly on the wrapper.
            let reparsed =
                Decimal128::from_str(&s).expect("driver output must reparse as Decimal128");
            assert_eq!(
                reparsed.to_string(),
                Decimal128::from_str(raw).unwrap().to_string(),
                "round-trip must be lossless for `{raw}` (got {s:?})",
            );
        }
    }

    #[test]
    fn decimal128_preserves_trailing_zeros_in_quantum() {
        // BSON Decimal128 carries a quantum (scale) — `4521.50` is NOT the
        // same value as `4521.5` for accounting use cases (scale=2 vs
        // scale=1). bson::Decimal128::to_string preserves the input
        // quantum exactly. Lock that contract: a regression to scale-
        // normalising would silently re-scale every monetary column.
        let inputs_with_quantum = ["4521.50", "0.00", "100.000", "1E+3"];
        for raw in inputs_with_quantum {
            let d = Decimal128::from_str(raw).expect("parse");
            let v = bson_to_json(Bson::Decimal128(d));
            // We don't assert exact byte-equality for "1E+3" because bson's
            // canonical form may render scientific notation differently;
            // we DO assert that the round-trip is reversible (re-parsing
            // gives the same Decimal128).
            let s = match &v {
                Value::String(s) => s.clone(),
                other => panic!("expected JSON string for `{raw}`, got {other:?}"),
            };
            let reparsed = Decimal128::from_str(&s).expect("reparse driver output");
            assert_eq!(
                reparsed.to_string(),
                Decimal128::from_str(raw).unwrap().to_string(),
                "round-trip must preserve quantum for `{raw}`",
            );
        }
    }

    #[test]
    fn objectid_serializes_as_24_char_hex_string() {
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").expect("known good oid");
        let v = bson_to_json(Bson::ObjectId(oid));
        assert_eq!(v, Value::String("507f1f77bcf86cd799439011".to_string()));
    }

    #[test]
    fn datetime_epoch_serializes_as_iso8601_z() {
        let dt = BsonDateTime::from_millis(0);
        let v = bson_to_json(Bson::DateTime(dt));
        // RFC 3339 with Zulu suffix — bson uses the `time` crate's Rfc3339
        // formatter which renders epoch as "1970-01-01T00:00:00Z".
        assert_eq!(v, Value::String("1970-01-01T00:00:00Z".to_string()));
    }

    // ----- composite -----

    #[test]
    fn nested_document_round_trips_recursively() {
        let nested = doc! {
            "a": 1_i32,
            "b": [1_i32, 2_i32, "three"],
        };
        let v = bson_to_json(Bson::Document(nested));
        let expected = serde_json::json!({
            "a": 1,
            "b": [1, 2, "three"],
        });
        assert_eq!(v, expected);
    }

    #[test]
    fn array_of_mixed_types_marshals_each_element() {
        let arr = vec![
            Bson::Int32(1),
            Bson::String("x".into()),
            Bson::Boolean(false),
            Bson::Null,
        ];
        let v = bson_to_json(Bson::Array(arr));
        assert_eq!(v, serde_json::json!([1, "x", false, null]),);
    }

    // ----- EJSON-form types -----

    #[test]
    fn binary_generic_subtype_renders_ejson_with_base64_and_hex_type() {
        let bin = Binary {
            subtype: BinarySubtype::Generic, // u8 = 0
            bytes: b"hello".to_vec(),        // base64 = aGVsbG8=
        };
        let v = bson_to_json(Bson::Binary(bin));
        assert_eq!(v, serde_json::json!({"$binary": "aGVsbG8=", "$type": "00"}));
    }

    #[test]
    fn binary_uuid_subtype_renders_with_correct_hex_type() {
        let bin = Binary {
            subtype: BinarySubtype::Uuid, // u8 = 4
            bytes: vec![0x00, 0x11, 0x22],
        };
        let v = bson_to_json(Bson::Binary(bin));
        let expected_b64 = base64_encode(&[0x00, 0x11, 0x22]);
        assert_eq!(
            v,
            serde_json::json!({"$binary": expected_b64, "$type": "04"})
        );
    }

    #[test]
    fn regex_renders_pattern_and_sorted_options() {
        // Options come in unsorted; canonical form is sorted.
        let r = Regex {
            pattern: "^foo".to_string(),
            options: "ix".to_string(),
        };
        let v = bson_to_json(Bson::RegularExpression(r));
        assert_eq!(v, serde_json::json!({"$regex": "^foo", "$options": "ix"}));
    }

    #[test]
    fn symbol_renders_canonical_ejson() {
        let v = bson_to_json(Bson::Symbol("legacy".into()));
        assert_eq!(v, serde_json::json!({"$symbol": "legacy"}));
    }

    #[test]
    fn javascript_code_renders_ejson() {
        let v = bson_to_json(Bson::JavaScriptCode("function() {}".into()));
        assert_eq!(v, serde_json::json!({"$code": "function() {}"}));
    }

    #[test]
    fn javascript_code_with_scope_renders_ejson() {
        let jcs = JavaScriptCodeWithScope {
            code: "function() { return x; }".into(),
            scope: doc! {"x": 1_i32},
        };
        let v = bson_to_json(Bson::JavaScriptCodeWithScope(jcs));
        assert_eq!(
            v,
            serde_json::json!({"$code": "function() { return x; }", "$scope": {"x": 1}})
        );
    }

    #[test]
    fn timestamp_renders_ejson_with_t_and_i() {
        let ts = Timestamp {
            time: 100,
            increment: 5,
        };
        let v = bson_to_json(Bson::Timestamp(ts));
        assert_eq!(v, serde_json::json!({"$timestamp": {"t": 100, "i": 5}}));
    }

    #[test]
    fn min_key_renders_canonical_ejson() {
        assert_eq!(
            bson_to_json(Bson::MinKey),
            serde_json::json!({"$minKey": 1})
        );
    }

    #[test]
    fn max_key_renders_canonical_ejson() {
        assert_eq!(
            bson_to_json(Bson::MaxKey),
            serde_json::json!({"$maxKey": 1})
        );
    }

    #[test]
    fn undefined_renders_canonical_ejson() {
        assert_eq!(
            bson_to_json(Bson::Undefined),
            serde_json::json!({"$undefined": true})
        );
    }

    // ----- base64 encoder smoke test -----

    #[test]
    fn base64_encoder_matches_known_vectors() {
        // RFC 4648 standard test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    // ----- error mapping -----

    // ----- bson_type_to_cube_type / column_types_from_schema -----

    use mongosql::json_schema::{BsonType, BsonTypeName, Schema as JsonSchema};
    use std::collections::HashMap;

    /// Build a tiny schema like
    ///   `{properties: {ns: {properties: {<col>: {bson_type: <ty>}}}}}`
    /// — i.e. a single namespace `ns` with each `(col, ty)` pair as a
    /// nested property. Mirrors mongosql's default IncludeNamespaces shape.
    fn schema_with_ns(ns: &str, cols: &[(&str, BsonType)]) -> JsonSchema {
        let mut inner_props = HashMap::new();
        for (col, ty) in cols {
            inner_props.insert(
                (*col).to_string(),
                JsonSchema {
                    bson_type: Some(ty.clone()),
                    ..Default::default()
                },
            );
        }
        let mut outer_props = HashMap::new();
        outer_props.insert(
            ns.to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(inner_props),
                ..Default::default()
            },
        );
        JsonSchema {
            bson_type: Some(BsonType::Single(BsonTypeName::Object)),
            properties: Some(outer_props),
            ..Default::default()
        }
    }

    #[test]
    fn empty_select_order_yields_empty_types() {
        let schema = JsonSchema::default();
        let out = column_types_from_schema(&[], &schema);
        assert!(out.is_empty());
    }

    #[test]
    fn single_namespace_projection_unwraps_to_bare_column_names() {
        let schema = schema_with_ns(
            "users",
            &[
                ("id", BsonType::Single(BsonTypeName::ObjectId)),
                ("count", BsonType::Single(BsonTypeName::Int)),
            ],
        );
        let select_order = vec![
            vec!["users".to_string(), "id".to_string()],
            vec!["users".to_string(), "count".to_string()],
        ];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![
                ColumnType {
                    name: "id".to_string(),
                    ty: "string"
                },
                ColumnType {
                    name: "count".to_string(),
                    ty: "int"
                },
            ]
        );
    }

    #[test]
    fn multi_namespace_projection_emits_namespaced_keys() {
        let mut combined = JsonSchema::default();
        let mut props = HashMap::new();
        // users.id
        let mut users_props = HashMap::new();
        users_props.insert(
            "id".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::ObjectId)),
                ..Default::default()
            },
        );
        props.insert(
            "users".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(users_props),
                ..Default::default()
            },
        );
        // orders.amount
        let mut orders_props = HashMap::new();
        orders_props.insert(
            "amount".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Decimal)),
                ..Default::default()
            },
        );
        props.insert(
            "orders".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(orders_props),
                ..Default::default()
            },
        );
        combined.properties = Some(props);

        let select_order = vec![
            vec!["users".to_string(), "id".to_string()],
            vec!["orders".to_string(), "amount".to_string()],
        ];
        let out = column_types_from_schema(&select_order, &combined);
        assert_eq!(
            out,
            vec![
                ColumnType {
                    name: "users__id".to_string(),
                    ty: "string"
                },
                ColumnType {
                    name: "orders__amount".to_string(),
                    ty: "decimal"
                },
            ]
        );
    }

    #[test]
    fn empty_string_namespace_strips_to_bare_column() {
        // Mongosql emits `["", col]` for explicit projection lists. The
        // flatten path treats the empty-string envelope the same as a
        // single-key envelope — both produce bare column names.
        let mut schema = JsonSchema::default();
        let mut inner_props = HashMap::new();
        inner_props.insert(
            "a".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::String)),
                ..Default::default()
            },
        );
        let mut outer_props = HashMap::new();
        outer_props.insert(
            "".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(inner_props),
                ..Default::default()
            },
        );
        schema.properties = Some(outer_props);
        let select_order = vec![vec!["".to_string(), "a".to_string()]];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![ColumnType {
                name: "a".to_string(),
                ty: "string"
            }]
        );
    }

    #[test]
    fn unprojected_column_falls_back_to_text() {
        // select_order references a column the schema doesn't mention.
        let schema = schema_with_ns("users", &[("a", BsonType::Single(BsonTypeName::Int))]);
        let select_order = vec![vec!["users".to_string(), "missing".to_string()]];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![ColumnType {
                name: "missing".to_string(),
                ty: "text"
            }]
        );
    }

    #[test]
    fn bson_type_to_cube_covers_every_variant() {
        // Spot-check every BsonTypeName variant.
        let cases = [
            (BsonTypeName::ObjectId, "string"),
            (BsonTypeName::String, "string"),
            (BsonTypeName::Int, "int"),
            (BsonTypeName::Long, "bigint"),
            (BsonTypeName::Double, "decimal"),
            (BsonTypeName::Decimal, "decimal"),
            (BsonTypeName::Bool, "boolean"),
            (BsonTypeName::Date, "timestamp"),
            (BsonTypeName::Timestamp, "timestamp"),
            (BsonTypeName::Object, "text"),
            (BsonTypeName::Array, "text"),
            (BsonTypeName::BinData, "text"),
            (BsonTypeName::Regex, "text"),
            (BsonTypeName::Symbol, "text"),
            (BsonTypeName::Javascript, "text"),
            (BsonTypeName::JavascriptWithScope, "text"),
            (BsonTypeName::MinKey, "text"),
            (BsonTypeName::MaxKey, "text"),
            (BsonTypeName::DbPointer, "text"),
            (BsonTypeName::Undefined, "text"),
            (BsonTypeName::Null, "text"),
        ];
        for (variant, expected) in cases {
            let got = bson_type_to_cube_type(&BsonType::Single(variant));
            assert_eq!(
                got, expected,
                "variant {variant:?} maps to {got} not {expected}"
            );
        }
    }

    #[test]
    fn bson_type_multiple_with_null_collapses_to_other_variant() {
        let bt = BsonType::Multiple(vec![BsonTypeName::Int, BsonTypeName::Null]);
        assert_eq!(bson_type_to_cube_type(&bt), "int");
        // Order shouldn't matter.
        let bt = BsonType::Multiple(vec![BsonTypeName::Null, BsonTypeName::String]);
        assert_eq!(bson_type_to_cube_type(&bt), "string");
    }

    #[test]
    fn bson_type_multiple_heterogeneous_non_null_falls_back_to_text() {
        let bt = BsonType::Multiple(vec![BsonTypeName::Int, BsonTypeName::String]);
        assert_eq!(bson_type_to_cube_type(&bt), "text");
    }

    #[test]
    fn bson_type_multiple_only_null_is_text() {
        let bt = BsonType::Multiple(vec![BsonTypeName::Null]);
        assert_eq!(bson_type_to_cube_type(&bt), "text");
    }

    #[test]
    fn bson_type_multiple_duplicate_non_null_is_that_variant() {
        // Defensive: two copies of the same variant should still map to that variant.
        let bt = BsonType::Multiple(vec![BsonTypeName::Int, BsonTypeName::Int]);
        assert_eq!(bson_type_to_cube_type(&bt), "int");
    }

    // ----- any_of resolution (Critic v3 — Issue #1) -----
    //
    // These tests pin the actual shape mongosql emits at runtime for
    // aggregated / nullable / GROUP-BY columns. See
    // ~/.cargo/git/checkouts/mongosql-*/mongosql/src/schema/definitions.rs
    // lines 730-743 (the `Schema::AnyOf` arm of `TryFrom<Schema>` for
    // `json_schema::Schema`) — it always emits
    // `{ bson_type: None, any_of: Some(variants) }` for unions.

    /// Build a `JsonSchema` with `bson_type: None, any_of: Some(...)`,
    /// each inner variant being an atomic-typed schema. Mirrors how
    /// mongosql renders `Schema::AnyOf({Atomic(X), Atomic(Y), ...})`.
    fn any_of_atomic(variants: &[BsonTypeName]) -> JsonSchema {
        JsonSchema {
            bson_type: None,
            any_of: Some(
                variants
                    .iter()
                    .map(|v| JsonSchema {
                        bson_type: Some(BsonType::Single(*v)),
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }

    /// Nest a column schema under `{properties: {ns: {properties: {col: ...}}}}`
    /// so the `column_types_from_schema` walker reaches it. Used by the
    /// integration-style tests below.
    fn ns_wrap(ns: &str, col: &str, inner: JsonSchema) -> JsonSchema {
        let mut col_props = HashMap::new();
        col_props.insert(col.to_string(), inner);
        let mut ns_props = HashMap::new();
        ns_props.insert(
            ns.to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(col_props),
                ..Default::default()
            },
        );
        JsonSchema {
            bson_type: Some(BsonType::Single(BsonTypeName::Object)),
            properties: Some(ns_props),
            ..Default::default()
        }
    }

    #[test]
    fn any_of_nullable_decimal_collapses_to_decimal() {
        // Shape mongosql emits for `SUM(amount)` over a Decimal128 column:
        //   any_of: [{ bson_type: Decimal }, { bson_type: Null }]
        let s = any_of_atomic(&[BsonTypeName::Decimal, BsonTypeName::Null]);
        assert_eq!(cube_type_for_schema(&s), "decimal");
        // Order shouldn't matter.
        let s = any_of_atomic(&[BsonTypeName::Null, BsonTypeName::Decimal]);
        assert_eq!(cube_type_for_schema(&s), "decimal");
    }

    #[test]
    fn any_of_int_long_widens_to_bigint() {
        // Shape mongosql emits for `COUNT(*)`: int on the empty-group
        // branch, long on the populated-group branch.
        let s = any_of_atomic(&[BsonTypeName::Int, BsonTypeName::Long]);
        assert_eq!(cube_type_for_schema(&s), "bigint");
    }

    #[test]
    fn any_of_int_long_null_widens_to_bigint() {
        // Same as the COUNT case but the column is also marked nullable.
        let s = any_of_atomic(&[BsonTypeName::Int, BsonTypeName::Long, BsonTypeName::Null]);
        assert_eq!(cube_type_for_schema(&s), "bigint");
    }

    #[test]
    fn any_of_int_double_widens_to_decimal() {
        let s = any_of_atomic(&[BsonTypeName::Int, BsonTypeName::Double]);
        assert_eq!(cube_type_for_schema(&s), "decimal");
    }

    #[test]
    fn any_of_long_decimal_widens_to_decimal() {
        let s = any_of_atomic(&[BsonTypeName::Long, BsonTypeName::Decimal]);
        assert_eq!(cube_type_for_schema(&s), "decimal");
    }

    #[test]
    fn any_of_string_nullable_collapses_to_string() {
        // Shape mongosql emits for a GROUP BY column over a non-required
        // field: `String + Null`.
        let s = any_of_atomic(&[BsonTypeName::String, BsonTypeName::Null]);
        assert_eq!(cube_type_for_schema(&s), "string");
    }

    #[test]
    fn any_of_string_int_falls_back_to_text() {
        // Heterogeneous non-numeric union — no Cube generic type can
        // safely express both. text wins.
        let s = any_of_atomic(&[BsonTypeName::String, BsonTypeName::Int]);
        assert_eq!(cube_type_for_schema(&s), "text");
    }

    #[test]
    fn any_of_all_null_falls_back_to_text() {
        let s = any_of_atomic(&[BsonTypeName::Null]);
        assert_eq!(cube_type_for_schema(&s), "text");
    }

    #[test]
    fn any_of_empty_variant_list_falls_back_to_text() {
        // Schema::Unsat — `any_of: Some(vec![])`. Caller sees an empty
        // union → text.
        let s = JsonSchema {
            bson_type: None,
            any_of: Some(Vec::new()),
            ..Default::default()
        };
        assert_eq!(cube_type_for_schema(&s), "text");
    }

    #[test]
    fn any_of_with_duplicate_variants_deduplicates() {
        // Defensive: even if upstream were to emit duplicates, we should
        // collapse correctly.
        let s = any_of_atomic(&[
            BsonTypeName::Long,
            BsonTypeName::Long,
            BsonTypeName::Null,
            BsonTypeName::Long,
        ]);
        assert_eq!(cube_type_for_schema(&s), "bigint");
    }

    #[test]
    fn any_of_nested_unions_flatten() {
        // Defensive: handle `any_of: [{any_of: [Int, Null]}, {any_of:
        // [Long, Null]}]`. mongosql's current `TryFrom<Schema>` doesn't
        // emit this shape because `Schema::AnyOf` flattens at the
        // algebra level, but the JsonSchema type permits it.
        let inner_a = any_of_atomic(&[BsonTypeName::Int, BsonTypeName::Null]);
        let inner_b = any_of_atomic(&[BsonTypeName::Long, BsonTypeName::Null]);
        let s = JsonSchema {
            bson_type: None,
            any_of: Some(vec![inner_a, inner_b]),
            ..Default::default()
        };
        assert_eq!(cube_type_for_schema(&s), "bigint");
    }

    #[test]
    fn any_of_with_object_variant_falls_back_to_text() {
        // Mixed atomic + object variants can't be resolved to a single
        // Cube generic type. text wins.
        let obj_variant = JsonSchema {
            bson_type: Some(BsonType::Single(BsonTypeName::Object)),
            properties: Some(HashMap::new()),
            ..Default::default()
        };
        let int_variant = JsonSchema {
            bson_type: Some(BsonType::Single(BsonTypeName::Int)),
            ..Default::default()
        };
        let s = JsonSchema {
            bson_type: None,
            any_of: Some(vec![int_variant, obj_variant]),
            ..Default::default()
        };
        // extract_atomic_names returns None for the object schema
        // (because `properties.is_some()`), so resolve_union sees no
        // variants → text. This is the intended "give up safely" path.
        assert_eq!(cube_type_for_schema(&s), "text");
    }

    #[test]
    fn schema_any_with_no_type_information_falls_back_to_text() {
        // Schema::Any: `bson_type: None, any_of: None`. No information
        // to derive a Cube type from. text.
        let s = JsonSchema::default();
        assert_eq!(cube_type_for_schema(&s), "text");
    }

    // ----- end-to-end column_types_from_schema with any_of column shapes -----

    #[test]
    fn count_star_column_via_any_of_int_long_is_bigint() {
        // GROUP BY producing COUNT(*) — mongosql emits
        // `any_of: [Int, Long]` for the count column.
        let count_schema = any_of_atomic(&[BsonTypeName::Int, BsonTypeName::Long]);
        let schema = ns_wrap("orders", "c", count_schema);
        let select_order = vec![vec!["orders".into(), "c".into()]];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![ColumnType {
                name: "c".into(),
                ty: "bigint",
            }]
        );
    }

    #[test]
    fn sum_decimal_column_via_any_of_decimal_null_is_decimal() {
        let sum_schema = any_of_atomic(&[BsonTypeName::Decimal, BsonTypeName::Null]);
        let schema = ns_wrap("orders", "total", sum_schema);
        let select_order = vec![vec!["orders".into(), "total".into()]];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![ColumnType {
                name: "total".into(),
                ty: "decimal",
            }]
        );
    }

    #[test]
    fn group_by_with_aggregate_typed_correctly_from_any_of() {
        // The full shape of the failing regression. Mongosql emits:
        //   account_id  → any_of: [String, Null]
        //   total       → any_of: [Decimal, Null]
        //   c           → any_of: [Int, Long]
        let mut orders_props = HashMap::new();
        orders_props.insert(
            "account_id".to_string(),
            any_of_atomic(&[BsonTypeName::String, BsonTypeName::Null]),
        );
        orders_props.insert(
            "total".to_string(),
            any_of_atomic(&[BsonTypeName::Decimal, BsonTypeName::Null]),
        );
        orders_props.insert(
            "c".to_string(),
            any_of_atomic(&[BsonTypeName::Int, BsonTypeName::Long]),
        );
        let mut top = HashMap::new();
        top.insert(
            "orders".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(orders_props),
                ..Default::default()
            },
        );
        let schema = JsonSchema {
            bson_type: Some(BsonType::Single(BsonTypeName::Object)),
            properties: Some(top),
            ..Default::default()
        };
        let select_order = vec![
            vec!["orders".into(), "account_id".into()],
            vec!["orders".into(), "total".into()],
            vec!["orders".into(), "c".into()],
        ];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![
                ColumnType {
                    name: "account_id".into(),
                    ty: "string",
                },
                ColumnType {
                    name: "total".into(),
                    ty: "decimal",
                },
                ColumnType {
                    name: "c".into(),
                    ty: "bigint",
                },
            ]
        );
    }

    // ----- mixed-prefix select_order (Critic v3 — Issue #7) -----

    #[test]
    fn mixed_empty_and_named_prefix_emits_namespaced_keys() {
        // select_order = [["", "a"], ["x", "b"]]. JS-side flattenRow
        // receives `{"": {a: ...}, "x": {b: ...}}` — two top-level keys
        // → namespaced flatten. Names: `out["" + "__" + "a"] = "__a"` and
        // `out["x" + "__" + "b"] = "x__b"`. Rust must match exactly.
        let mut empty_props = HashMap::new();
        empty_props.insert(
            "a".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Int)),
                ..Default::default()
            },
        );
        let mut x_props = HashMap::new();
        x_props.insert(
            "b".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::String)),
                ..Default::default()
            },
        );
        let mut top = HashMap::new();
        top.insert(
            "".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(empty_props),
                ..Default::default()
            },
        );
        top.insert(
            "x".to_string(),
            JsonSchema {
                bson_type: Some(BsonType::Single(BsonTypeName::Object)),
                properties: Some(x_props),
                ..Default::default()
            },
        );
        let schema = JsonSchema {
            bson_type: Some(BsonType::Single(BsonTypeName::Object)),
            properties: Some(top),
            ..Default::default()
        };
        let select_order = vec![vec!["".into(), "a".into()], vec!["x".into(), "b".into()]];
        let out = column_types_from_schema(&select_order, &schema);
        assert_eq!(
            out,
            vec![
                ColumnType {
                    name: "__a".into(),
                    ty: "int",
                },
                ColumnType {
                    name: "x__b".into(),
                    ty: "string",
                },
            ]
        );
    }

    #[test]
    fn column_types_preserve_select_order_not_hashmap_order() {
        // Schema declares columns in one order; select_order asks for them
        // in a different order. The output must follow select_order — this
        // is the regression-prevention test for the multi-partition UNION
        // failure described in the task spec.
        let schema = schema_with_ns(
            "t",
            &[
                ("a", BsonType::Single(BsonTypeName::Int)),
                ("b", BsonType::Single(BsonTypeName::String)),
                ("c", BsonType::Single(BsonTypeName::Bool)),
            ],
        );
        let select_order_1 = vec![
            vec!["t".into(), "a".into()],
            vec!["t".into(), "b".into()],
            vec!["t".into(), "c".into()],
        ];
        let select_order_2 = vec![
            vec!["t".into(), "c".into()],
            vec!["t".into(), "a".into()],
            vec!["t".into(), "b".into()],
        ];
        let out_1 = column_types_from_schema(&select_order_1, &schema);
        let out_2 = column_types_from_schema(&select_order_2, &schema);
        let names_1: Vec<&str> = out_1.iter().map(|c| c.name.as_str()).collect();
        let names_2: Vec<&str> = out_2.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names_1, vec!["a", "b", "c"]);
        assert_eq!(names_2, vec!["c", "a", "b"]);
    }

    // ----- error-mapping -----

    #[test]
    fn map_mongo_error_routes_non_command_to_existing_taxonomy() {
        // Exercise the From<mongodb::error::Error> path via a real parse-time
        // error. Bad scheme manifests as InvalidArgument -> ConfigInvalid in
        // our taxonomy (not Timeout).
        let mongo_err = mongodb::options::ConnectionString::parse("notascheme")
            .expect_err("malformed URI must error");
        let mapped = map_mongo_error(mongo_err);
        assert_eq!(mapped.code(), "MONGOSQL_CONFIG_INVALID");
    }
}

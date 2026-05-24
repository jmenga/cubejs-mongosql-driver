//! mongosql translation wrapper. See ARCHITECTURE.md §4.1, SPEC.md §5.2 / FR-4.
//!
//! T07 is a thin wrapper around `mongosql::translate_sql` that:
//!
//! 1. Hides the `mongosql::result::Error` type behind our [`Error::TranslateFailed`].
//! 2. Unwraps the upstream [`mongosql::Translation::pipeline`] (which is a
//!    `bson::Bson::Array` of `bson::Bson::Document` values) into a typed
//!    `Vec<bson::Document>` ready to feed to `mongodb::Collection::aggregate`
//!    or `mongodb::Database::aggregate` (T08).
//! 3. Surfaces `target_db` and `target_collection` exactly as upstream returns
//!    them. `target_collection` is `Option<String>` — `None` means the SQL
//!    translates to a database-level aggregate (e.g. some cross-collection
//!    queries) and the executor must call `db.aggregate` rather than
//!    `db.collection(...).aggregate`.
//! 4. Carries through the upstream `result_set_schema` (`json_schema::Schema`)
//!    and `select_order` (`Vec<Vec<String>>`) so the executor can emit an
//!    ordered, type-authoritative `(name, type)` list for callers. Without
//!    these the driver previously sniffed types from the first row's
//!    `Object.keys()` order, which is not stable across translations of the
//!    same SQL: mongosql constructs its `$project` stage by iterating a
//!    HashMap-backed `Schema::Document`, so the projected field order in
//!    each row differs partition-to-partition. Divergent column orders
//!    across partition rebuilds broke Cube Store UNIONs with
//!    `type_coercion` errors. The `select_order` field is itself a
//!    deterministic `Vec` (parse-order from the SQL SELECT clause), and the
//!    `result_set_schema` provides the authoritative per-field BSON type
//!    declaration including `any_of` unions for nullable/aggregated columns.
//!
//! ## Database-name strategy
//!
//! `mongosql::Catalog` is keyed by `(database, collection)` namespaces.
//! Collection-mode (`load_from_collection`) keys under the configured
//! `db_name`; File-mode (`load_from_file`) keys under
//! [`crate::schema::FILE_MODE_DB_PLACEHOLDER`] (currently `""`) because the
//! file envelope carries no database identifier. See `schema.rs` module docs
//! and Discoveries 2026-05-09 — T05.
//!
//! `translate(sql, &catalog, default_db)` passes `default_db` straight through
//! to `mongosql::translate_sql` as `current_db`. **The caller is responsible
//! for ensuring `default_db` matches the key under which the catalog was
//! built.** If the catalog was built via `load_from_file`, the caller MUST
//! either pass `FILE_MODE_DB_PLACEHOLDER` here and rewrite
//! `Translation.target_db` to the configured database afterwards, OR rebuild
//! the catalog under the real database name before caching. The napi-rs
//! surface (T09) is the appropriate place to normalize this — translate.rs
//! stays a dumb shim.
//!
//! Choice for T07: we keep `translate` as a passthrough rather than peeking
//! into the opaque `Catalog`. Reasons:
//!
//! - `Catalog` exposes no iterator over its keys, so this module can't
//!   introspect "which db was this catalog built under?" without extra
//!   bookkeeping outside the catalog itself.
//! - Adding bookkeeping here would couple `translate.rs` to the schema
//!   loaders, which is the wrong direction; T09 owns the configuration and
//!   already knows whether it constructed the cache from a collection or a
//!   file, so re-keying is its concern.
//!
//! Tests in this module pass `FILE_MODE_DB_PLACEHOLDER` because the fixture
//! catalog is loaded via `load_from_file`.

use mongosql::json_schema;

use crate::error::{Error, Result};
use crate::schema::MongoSqlCatalog;

/// Cap on the size of the SQL fragment we embed in
/// [`Error::TranslateFailed`] messages, in characters. Keeps logs readable
/// when callers paste large queries that fail to translate.
const MAX_SQL_IN_ERROR: usize = 512;

/// Result of translating a SQL query against a cached schema.
///
/// All fields are owned (no borrows of the catalog) so the value can cross
/// task boundaries freely.
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by tests today
#[derive(Debug, Clone)]
pub struct Translation {
    /// Target database the aggregate should run in. Sourced from
    /// `mongosql::Translation::target_db`, which is upstream's
    /// `mql_translation.database.unwrap_or_else(|| current_db.to_string())`.
    pub target_db: String,
    /// Target collection. `None` means a database-level aggregate
    /// (`db.aggregate(pipeline)`) is required — e.g. some cross-collection
    /// SQL forms produce no single-collection target.
    pub target_collection: Option<String>,
    /// MQL aggregation pipeline as a vector of BSON documents. Upstream
    /// returns this as `bson::Bson::Array(bson::Bson::Document(...))`; we
    /// unwrap it eagerly so callers can hand it directly to
    /// `mongodb::Collection::aggregate` / `Database::aggregate` without a
    /// second conversion. Failure to unwrap (i.e. mongosql produces a
    /// non-Array, or an array element that isn't a Document) is surfaced as
    /// `Error::TranslateFailed`.
    pub pipeline: Vec<bson::Document>,
    /// Authoritative JSON Schema for the result set, as produced by
    /// `mongosql`. Drives the column-name + type list returned alongside
    /// each query — replaces the old value-sniffing heuristic. Cloned
    /// straight from `mongosql::Translation::result_set_schema`.
    pub result_set_schema: json_schema::Schema,
    /// Projection order as parsed from the SQL SELECT clause.
    ///
    /// Each entry is a path: with the default `IncludeNamespaces` option
    /// (what we use) the inner vector is `[namespace, column]`; with
    /// `ExcludeNamespaces` it would be `[column]`. We pass entries through
    /// as-is; the executor flattens them to `<namespace>__<column>` keys
    /// to match the `flattenRow` rule in the TS wrapper.
    pub select_order: Vec<Vec<String>>,
}

/// Translate a SQL string into an MQL pipeline using the provided catalog.
///
/// `default_db` is passed to `mongosql::translate_sql` as `current_db`. See
/// the module docs for the keying strategy and which value to pass in the
/// File-mode case.
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by tests today
pub fn translate(sql: &str, schema: &MongoSqlCatalog, default_db: &str) -> Result<Translation> {
    if sql.trim().is_empty() {
        return Err(Error::TranslateFailed {
            msg: "empty SQL".to_string(),
        });
    }

    let upstream = mongosql::translate_sql(
        default_db,
        sql,
        schema,
        mongosql::options::SqlOptions::default(),
    )
    .map_err(|err| translate_error(sql, &err))?;

    let mut pipeline = unwrap_pipeline(upstream.pipeline)?;
    // Post-translation rewrite: flatten right-leaning `$or` chains and
    // collapse same-field `$eq` disjunctions to `$in`. Defends against
    // mongosql v1.8.5's `IN (v1, ..., vN)` → right-leaning binary-`$or`
    // chain that overflows MongoDB's max BSON nesting depth (100) when
    // N is large. See `pipeline_rewrite` module docs.
    crate::pipeline_rewrite::flatten_or_chains_and_collapse_to_in(&mut pipeline);

    Ok(Translation {
        target_db: upstream.target_db,
        target_collection: upstream.target_collection,
        pipeline,
        result_set_schema: upstream.result_set_schema,
        select_order: upstream.select_order,
    })
}

/// Convert a mongosql translation error into our taxonomy.
///
/// We always include the SQL fragment (truncated to [`MAX_SQL_IN_ERROR`]) in
/// the message so logs make the failure self-evident. The upstream Display
/// already names the parser/algebrizer/codegen subsystem; we don't strip that.
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by tests today
fn translate_error(sql: &str, err: &mongosql::result::Error) -> Error {
    let truncated_sql = truncate_for_error(sql);
    Error::TranslateFailed {
        msg: format!("{err}; sql=`{truncated_sql}`"),
    }
}

#[allow(dead_code)] // see translate_error
fn truncate_for_error(s: &str) -> String {
    // Whitespace-collapse so multi-line SQL with indentation doesn't blow the
    // cap on the first line break.
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");

    if collapsed.chars().count() <= MAX_SQL_IN_ERROR {
        collapsed
    } else {
        let mut out: String = collapsed.chars().take(MAX_SQL_IN_ERROR).collect();
        out.push('…');
        out
    }
}

/// Unwrap mongosql's `bson::Bson::Array` pipeline into the typed
/// `Vec<bson::Document>` the executor expects. Public to the crate so that
/// the unit tests can drive it directly without going through
/// `mongosql::translate_sql`.
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by tests today
pub(crate) fn unwrap_pipeline(pipeline: bson::Bson) -> Result<Vec<bson::Document>> {
    let stages = match pipeline {
        bson::Bson::Array(stages) => stages,
        other => {
            return Err(Error::TranslateFailed {
                msg: format!(
                    "expected pipeline to be a BSON Array of Documents, got `{:?}`",
                    other.element_type(),
                ),
            });
        }
    };

    let mut out: Vec<bson::Document> = Vec::with_capacity(stages.len());
    for (idx, stage) in stages.into_iter().enumerate() {
        match stage {
            bson::Bson::Document(d) => out.push(d),
            other => {
                return Err(Error::TranslateFailed {
                    msg: format!(
                        "unexpected pipeline element type at index {idx}: `{:?}`; expected Document",
                        other.element_type(),
                    ),
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{load_from_file, FILE_MODE_DB_PLACEHOLDER};
    use std::path::PathBuf;

    /// Path to the YAML fixture used by both the file-mode loader tests and
    /// these translate tests. CARGO_MANIFEST_DIR points at crates/native;
    /// fixtures live at the repo root under tests/integration/fixtures/.
    fn fixture_path() -> PathBuf {
        let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        crate_dir
            .join("..")
            .join("..")
            .join("tests")
            .join("integration")
            .join("fixtures")
            .join("mongo-schema.yaml")
    }

    /// Build the test catalog once per call. The fixture defines users,
    /// accounts, orders under [`FILE_MODE_DB_PLACEHOLDER`].
    fn fixture_catalog() -> MongoSqlCatalog {
        load_from_file(&fixture_path()).expect("fixture catalog loads")
    }

    /// `default_db` value to use across these tests. The fixture loader keys
    /// under the placeholder, so we must pass the same value to translate so
    /// that mongosql can resolve namespaces.
    fn db() -> &'static str {
        FILE_MODE_DB_PLACEHOLDER
    }

    /// Returns `true` if the pipeline contains a stage whose top-level key
    /// matches `op` (e.g. `"$match"`, `"$group"`, `"$lookup"`).
    fn pipeline_contains_op(pipeline: &[bson::Document], op: &str) -> bool {
        pipeline.iter().any(|stage| stage.contains_key(op))
    }

    /// Returns the first stage whose top-level key matches `op`, if any.
    fn first_stage_with<'a>(
        pipeline: &'a [bson::Document],
        op: &str,
    ) -> Option<&'a bson::Document> {
        pipeline.iter().find(|stage| stage.contains_key(op))
    }

    /// Returns the *body* of the first stage with the given operator: i.e.
    /// `stage.get(op)`, unwrapping the BSON value.
    fn first_stage_body<'a>(pipeline: &'a [bson::Document], op: &str) -> Option<&'a bson::Bson> {
        first_stage_with(pipeline, op).and_then(|s| s.get(op))
    }

    /// Recursively check whether the BSON value contains the literal string
    /// anywhere — useful for "the pipeline references `account_id` somewhere"
    /// assertions without coupling to mongosql's exact stage layout.
    fn bson_contains_string(b: &bson::Bson, needle: &str) -> bool {
        match b {
            bson::Bson::String(s) => s.contains(needle),
            bson::Bson::Document(d) => d
                .iter()
                .any(|(k, v)| k.contains(needle) || bson_contains_string(v, needle)),
            bson::Bson::Array(a) => a.iter().any(|v| bson_contains_string(v, needle)),
            _ => false,
        }
    }

    fn pipeline_contains_string(pipeline: &[bson::Document], needle: &str) -> bool {
        pipeline
            .iter()
            .any(|d| bson_contains_string(&bson::Bson::Document(d.clone()), needle))
    }

    // ----- happy path -----

    #[test]
    fn select_star_returns_users_collection() {
        let cat = fixture_catalog();
        let t = translate("SELECT * FROM users", &cat, db()).expect("translates");
        assert_eq!(t.target_collection.as_deref(), Some("users"));
        assert!(!t.pipeline.is_empty(), "expected non-empty pipeline");
    }

    #[test]
    fn count_star_emits_group_stage() {
        let cat = fixture_catalog();
        let t = translate("SELECT COUNT(*) FROM users", &cat, db()).expect("translates");
        assert_eq!(t.target_collection.as_deref(), Some("users"));
        assert!(
            pipeline_contains_op(&t.pipeline, "$group"),
            "expected $group stage in pipeline, got: {:?}",
            t.pipeline,
        );

        // The $group stage exists; its _id is null/literal (count-all has no
        // group key). mongosql may render this as Bson::Null or {"$literal": ...}.
        let group = first_stage_body(&t.pipeline, "$group").expect("$group body");
        let id = match group {
            bson::Bson::Document(d) => d.get("_id").expect("$group._id present"),
            other => panic!("$group body should be a document, got {other:?}"),
        };
        // Accept any non-field-reference _id form: Null, literal, or an
        // expression document with no $-prefixed field reference. The
        // important property is that we are NOT grouping by a column.
        let id_is_count_all = matches!(
            id,
            bson::Bson::Null
                | bson::Bson::Document(_)
                | bson::Bson::String(_)
                | bson::Bson::Int32(_)
                | bson::Bson::Int64(_)
        );
        assert!(id_is_count_all, "$group._id has unexpected shape: {id:?}");

        // And the pipeline overall must contain *some* counting accumulator
        // (`$sum` or `$count`). mongosql commonly emits `$sum: 1`.
        let has_count_accumulator = pipeline_contains_string(&t.pipeline, "$sum")
            || pipeline_contains_string(&t.pipeline, "$count");
        assert!(
            has_count_accumulator,
            "expected $sum or $count accumulator somewhere in pipeline: {:?}",
            t.pipeline
        );
    }

    #[test]
    fn group_by_emits_group_with_account_id() {
        let cat = fixture_catalog();
        let t = translate(
            "SELECT account_id, COUNT(*) AS c FROM orders GROUP BY account_id",
            &cat,
            db(),
        )
        .expect("translates");
        assert_eq!(t.target_collection.as_deref(), Some("orders"));
        assert!(
            pipeline_contains_op(&t.pipeline, "$group"),
            "expected $group stage in pipeline, got: {:?}",
            t.pipeline,
        );
        // The group key must reference `account_id` somewhere in the BSON.
        let group = first_stage_body(&t.pipeline, "$group").expect("$group body");
        assert!(
            bson_contains_string(group, "account_id"),
            "$group body should reference account_id, got: {group:?}",
        );
    }

    #[test]
    fn where_clause_emits_match_stage() {
        let cat = fixture_catalog();
        let t = translate("SELECT * FROM orders WHERE status = 'paid'", &cat, db())
            .expect("translates");
        assert_eq!(t.target_collection.as_deref(), Some("orders"));
        assert!(
            pipeline_contains_op(&t.pipeline, "$match"),
            "expected $match stage in pipeline, got: {:?}",
            t.pipeline,
        );
        assert!(
            pipeline_contains_string(&t.pipeline, "status"),
            "expected pipeline to reference `status`",
        );
    }

    #[test]
    fn join_emits_lookup_stage() {
        let cat = fixture_catalog();
        let sql = "SELECT u.name, o.amount \
                   FROM users u \
                   JOIN orders o ON o.account_id = u.account_id";
        let t = translate(sql, &cat, db()).expect("translates");
        assert!(
            t.target_collection.is_some(),
            "join should resolve to a target collection, got None",
        );
        assert!(
            pipeline_contains_op(&t.pipeline, "$lookup"),
            "expected $lookup stage for JOIN, got: {:?}",
            t.pipeline,
        );
    }

    #[test]
    fn date_filter_emits_match_referencing_created_at() {
        let cat = fixture_catalog();
        // MongoSQL's date type is `TIMESTAMP` (per FR-2), but the parser does
        // NOT accept the SQL-92 `TIMESTAMP 'literal'` form. The supported
        // surface forms are `CAST('literal' AS TIMESTAMP)` and the ODBC-style
        // `{ts 'literal'}` escape. We use CAST here.
        let sql =
            "SELECT * FROM orders WHERE created_at >= CAST('2026-04-01T00:00:00Z' AS TIMESTAMP)";
        let t = translate(sql, &cat, db()).expect("translates");
        assert_eq!(t.target_collection.as_deref(), Some("orders"));
        assert!(
            pipeline_contains_op(&t.pipeline, "$match"),
            "expected $match for date filter, got: {:?}",
            t.pipeline,
        );
        assert!(
            pipeline_contains_string(&t.pipeline, "created_at"),
            "expected pipeline to reference created_at",
        );
        // The literal should land somewhere as a DateTime BSON value. We don't
        // enforce a particular wire form (literal, $date, etc.) — we just
        // assert *some* DateTime appears in the pipeline.
        fn contains_datetime(b: &bson::Bson) -> bool {
            match b {
                bson::Bson::DateTime(_) => true,
                bson::Bson::Document(d) => d.values().any(contains_datetime),
                bson::Bson::Array(a) => a.iter().any(contains_datetime),
                _ => false,
            }
        }
        let any_datetime = t
            .pipeline
            .iter()
            .any(|d| contains_datetime(&bson::Bson::Document(d.clone())));
        assert!(
            any_datetime,
            "expected a DateTime BSON value in the pipeline for the date filter",
        );
    }

    #[test]
    fn subquery_in_from_translates() {
        let cat = fixture_catalog();
        let sql = "SELECT t.account_id FROM (SELECT account_id FROM orders) AS t";
        let t = translate(sql, &cat, db()).expect("subquery in FROM should translate");
        assert!(!t.pipeline.is_empty());
    }

    #[test]
    fn union_all_emits_union_with() {
        let cat = fixture_catalog();
        // Both branches return the same shape.
        let sql = "SELECT account_id FROM orders UNION ALL SELECT account_id FROM users";
        let t = translate(sql, &cat, db()).expect("union all translates");
        assert!(
            pipeline_contains_op(&t.pipeline, "$unionWith"),
            "expected $unionWith stage in UNION ALL output, got: {:?}",
            t.pipeline,
        );
    }

    // ----- determinism -----

    #[test]
    fn translation_is_deterministic_within_version() {
        let cat = fixture_catalog();
        let sql = "SELECT account_id, COUNT(*) AS c FROM orders GROUP BY account_id";
        let a = translate(sql, &cat, db()).expect("first translate");
        let b = translate(sql, &cat, db()).expect("second translate");
        assert_eq!(a.target_db, b.target_db);
        assert_eq!(a.target_collection, b.target_collection);
        // bson::Document is `PartialEq` for byte-identical docs; this is
        // safe to compare for "same input → same output" within one mongosql
        // version. We do NOT assert byte stability across versions.
        assert_eq!(a.pipeline, b.pipeline);
    }

    // ----- error paths -----

    #[test]
    fn ambiguous_column_in_join_yields_translate_failed() {
        // mongosql's default SqlOptions runs in `Relaxed` schema-checking mode,
        // so an unknown bare column reference does NOT error at translate time
        // (the BSON path simply yields MISSING at runtime). What *does* fail
        // at translation, regardless of mode, is an unambiguously broken
        // reference — here, an ambiguous column name across a JOIN's two
        // sides. Both `users` and `accounts` define `created_at`, so the
        // unqualified reference cannot resolve.
        let cat = fixture_catalog();
        let sql = "SELECT created_at FROM users JOIN accounts ON users.account_id = accounts._id";
        match translate(sql, &cat, db()) {
            Err(Error::TranslateFailed { msg }) => {
                let lower = msg.to_ascii_lowercase();
                assert!(
                    lower.contains("ambiguous") || lower.contains("created_at"),
                    "error msg should name the ambiguous reference, got: {msg}",
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }

    #[test]
    fn unknown_table_yields_translate_failed_with_table_name() {
        let cat = fixture_catalog();
        let sql = "SELECT * FROM does_not_exist";
        match translate(sql, &cat, db()) {
            Err(Error::TranslateFailed { msg }) => {
                assert!(
                    msg.contains("does_not_exist"),
                    "error msg should mention the unknown table, got: {msg}",
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }

    #[test]
    fn empty_sql_yields_translate_failed() {
        let cat = fixture_catalog();
        match translate("", &cat, db()) {
            Err(Error::TranslateFailed { msg }) => {
                assert!(
                    msg.to_ascii_lowercase().contains("empty"),
                    "error msg should mention emptiness, got: {msg}",
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }

    #[test]
    fn whitespace_only_sql_yields_translate_failed() {
        let cat = fixture_catalog();
        match translate("   \n\t  ", &cat, db()) {
            Err(Error::TranslateFailed { .. }) => {}
            other => panic!("expected TranslateFailed for whitespace-only SQL, got {other:?}"),
        }
    }

    #[test]
    fn parse_error_includes_sql_fragment() {
        let cat = fixture_catalog();
        let sql = "SELECT FROM"; // syntactically wrong
        match translate(sql, &cat, db()) {
            Err(Error::TranslateFailed { msg }) => {
                assert!(
                    msg.contains("SELECT FROM"),
                    "error msg should embed the failing SQL fragment, got: {msg}",
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }

    #[test]
    fn long_sql_in_error_is_truncated() {
        let cat = fixture_catalog();
        // Build a SQL string whose collapsed-whitespace form is comfortably
        // longer than MAX_SQL_IN_ERROR. Use a syntactic error so translate
        // returns Err and embeds the SQL.
        let mut sql = String::from("SELECT FROM ");
        sql.push_str(&"abcdefghij".repeat(MAX_SQL_IN_ERROR)); // ~5120 chars
        match translate(&sql, &cat, db()) {
            Err(Error::TranslateFailed { msg }) => {
                // The msg shape is "<upstream display>; sql=`<truncated>`"
                let after = msg
                    .rsplit("sql=`")
                    .next()
                    .expect("error message contains sql=`...`");
                let inner = after.trim_end_matches('`');
                let inner = inner.trim_end_matches('…');
                assert!(
                    inner.chars().count() <= MAX_SQL_IN_ERROR,
                    "embedded SQL fragment should be <= {} chars, got {}",
                    MAX_SQL_IN_ERROR,
                    inner.chars().count(),
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }

    // ----- pipeline-unwrap helper -----

    #[test]
    fn unwrap_pipeline_accepts_bson_array_of_documents() {
        let arr = bson::Bson::Array(vec![
            bson::Bson::Document(bson::doc! {"$match": {"a": 1}}),
            bson::Bson::Document(bson::doc! {"$limit": 10_i64}),
        ]);
        let stages = unwrap_pipeline(arr).expect("array of docs unwraps");
        assert_eq!(stages.len(), 2);
        assert!(stages[0].contains_key("$match"));
        assert!(stages[1].contains_key("$limit"));
    }

    #[test]
    fn unwrap_pipeline_rejects_non_array() {
        let not_an_array = bson::Bson::Null;
        match unwrap_pipeline(not_an_array) {
            Err(Error::TranslateFailed { msg }) => {
                assert!(
                    msg.contains("Array"),
                    "error msg should mention expected Array, got: {msg}",
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }

    // ----- result_set_schema / select_order passthrough -----

    #[test]
    fn select_order_passthrough_for_explicit_projection() {
        // Explicit projection list must appear in `select_order` in the
        // *projection order*, not whatever HashMap order
        // `result_set_schema.properties` happens to enumerate. Default
        // SqlOptions use `IncludeNamespaces`, so each entry is
        // `[<namespace>, <column>]`.
        let cat = fixture_catalog();
        let t = translate("SELECT account_id, status, amount FROM orders", &cat, db())
            .expect("translate");
        let columns: Vec<&str> = t
            .select_order
            .iter()
            .map(|p| p.last().expect("non-empty path").as_str())
            .collect();
        assert_eq!(columns, vec!["account_id", "status", "amount"]);
        // Namespace component must be present (default IncludeNamespaces).
        for path in &t.select_order {
            assert_eq!(path.len(), 2, "expected [namespace, column], got {path:?}");
        }
    }

    #[test]
    fn result_set_schema_populated_with_field_types() {
        // The schema must enumerate the projected columns with their BSON
        // types. We don't enforce a specific shape (mongosql may wrap the
        // root in an extra envelope) but a known column must be reachable
        // and carry a non-empty `bson_type`.
        let cat = fixture_catalog();
        let t = translate("SELECT account_id FROM orders", &cat, db()).expect("translate");
        // Walk: top-level Schema has a `properties` map keyed by namespace,
        // each value is itself a Schema whose `properties` carry columns.
        let top_props = t
            .result_set_schema
            .properties
            .as_ref()
            .expect("top-level properties present");
        // Find any property whose nested schema mentions `account_id`.
        let mut found = false;
        for schema in top_props.values() {
            if let Some(cols) = &schema.properties {
                if cols.contains_key("account_id") {
                    found = true;
                    break;
                }
            }
        }
        assert!(
            found,
            "result_set_schema should expose `account_id` somewhere in the projection tree: {top_props:?}"
        );
    }

    #[test]
    fn select_order_and_schema_are_deterministic() {
        // Same SQL → same select_order *and* the same projected columns in
        // the schema. This is the property that lets the executor produce
        // a stable column ordering across partitions; the BSON cursor's
        // first-row Object.keys() does not guarantee it.
        let cat = fixture_catalog();
        let sql = "SELECT account_id, status FROM orders";
        let a = translate(sql, &cat, db()).expect("first translate");
        let b = translate(sql, &cat, db()).expect("second translate");
        assert_eq!(a.select_order, b.select_order);
        assert_eq!(
            a.result_set_schema.properties.as_ref().map(|p| {
                let mut ks: Vec<&str> = p.keys().map(|s| s.as_str()).collect();
                ks.sort();
                ks
            }),
            b.result_set_schema.properties.as_ref().map(|p| {
                let mut ks: Vec<&str> = p.keys().map(|s| s.as_str()).collect();
                ks.sort();
                ks
            }),
        );
    }

    // ----- any_of-resolution end-to-end via translate_sql (Critic v3 — Issue #3) -----
    //
    // These tests close the loop on the `any_of` regression: drive a
    // real `mongosql::translate_sql` against the YAML fixture catalog,
    // then run the resulting Translation through
    // `execute::column_types_from_schema`. The fixture's `orders` schema
    // declares `amount` as Decimal128 and the seed-data fixture mirrors
    // the e2e cluster; aggregation SQL exercises the very `any_of`
    // shapes (`[Decimal, Null]`, `[Int, Long]`, `[String, Null]`) the
    // critic flagged.

    use crate::execute::column_types_from_schema;

    #[test]
    fn aggregate_sum_decimal_yields_decimal_type() {
        let cat = fixture_catalog();
        let t =
            translate("SELECT SUM(amount) AS total FROM orders", &cat, db()).expect("translate");
        let types = column_types_from_schema(&t.select_order, &t.result_set_schema);
        assert_eq!(types.len(), 1, "single projection");
        // Per the fixture's `amount: { bsonType: decimal }`, mongosql
        // models `SUM(decimal)` as `AnyOf{Decimal, Null}`. We must
        // collapse to `decimal` — NOT `text` (the pre-fix behaviour).
        assert_eq!(types[0].ty, "decimal", "got {:?}", types);
    }

    #[test]
    fn aggregate_count_star_yields_bigint_type() {
        let cat = fixture_catalog();
        let t = translate("SELECT COUNT(*) AS n FROM orders", &cat, db()).expect("translate");
        let types = column_types_from_schema(&t.select_order, &t.result_set_schema);
        assert_eq!(types.len(), 1, "single projection");
        // `COUNT(*)` produces `AnyOf{Int, Long}` per mongosql's
        // accumulator types. Widens to bigint, not text.
        assert_eq!(types[0].ty, "bigint", "got {:?}", types);
    }

    #[test]
    fn group_by_with_aggregates_types_each_column_correctly() {
        // The shape that caused the multi-partition UNION failure:
        // GROUP BY a string column, projecting SUM + COUNT alongside.
        // All three columns return `any_of` shapes from mongosql; all
        // three must classify correctly.
        let cat = fixture_catalog();
        let sql = "SELECT account_id, SUM(amount) AS total, COUNT(*) AS c \
                   FROM orders GROUP BY account_id";
        let t = translate(sql, &cat, db()).expect("translate");
        let types = column_types_from_schema(&t.select_order, &t.result_set_schema);
        let by_name: std::collections::HashMap<&str, &str> =
            types.iter().map(|c| (c.name.as_str(), c.ty)).collect();
        // account_id is nullable string per the fixture (no `required`).
        assert_eq!(
            by_name.get("account_id"),
            Some(&"string"),
            "got {:?}",
            types
        );
        assert_eq!(by_name.get("total"), Some(&"decimal"), "got {:?}", types);
        assert_eq!(by_name.get("c"), Some(&"bigint"), "got {:?}", types);
    }

    #[test]
    fn select_order_for_grouped_aggregate_is_stable_across_translations() {
        // Two translations of the same SQL must yield byte-identical
        // type lists. Pre-fix, the value-sniffing path could rotate
        // column order between calls; post-fix, mongosql's `select_order`
        // is the source of truth and is itself a `Vec<Vec<String>>` (no
        // HashMap involvement). Lock that contract here for the
        // aggregate-driven shape, since that's what partitioned
        // pre-aggregations exercise.
        let cat = fixture_catalog();
        let sql = "SELECT account_id, SUM(amount) AS total, COUNT(*) AS c \
                   FROM orders GROUP BY account_id";
        let a = translate(sql, &cat, db()).expect("a");
        let b = translate(sql, &cat, db()).expect("b");
        let types_a = column_types_from_schema(&a.select_order, &a.result_set_schema);
        let types_b = column_types_from_schema(&b.select_order, &b.result_set_schema);
        let order_a: Vec<&str> = types_a.iter().map(|c| c.name.as_str()).collect();
        let order_b: Vec<&str> = types_b.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(order_a, order_b);
        // And the named-order matches the SELECT projection order.
        assert_eq!(order_a, vec!["account_id", "total", "c"]);
    }

    #[test]
    fn unwrap_pipeline_rejects_non_document_element() {
        let arr = bson::Bson::Array(vec![
            bson::Bson::Document(bson::doc! {"$match": {"a": 1}}),
            bson::Bson::String("not a stage".to_string()),
        ]);
        match unwrap_pipeline(arr) {
            Err(Error::TranslateFailed { msg }) => {
                assert!(
                    msg.contains("index 1"),
                    "error msg should call out the offending index, got: {msg}",
                );
            }
            other => panic!("expected TranslateFailed, got {other:?}"),
        }
    }
}

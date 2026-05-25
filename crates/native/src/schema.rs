//! Schema loader and cache. See ARCHITECTURE.md §3 and SPEC.md §5.3.
//!
//! Three schema-source modes are supported. Each produces the same
//! [`LoadedSchema`] shape (a [`MongoSqlCatalog`] plus a parallel [`TableColumns`]
//! map keyed by `(db, collection)`), and all three are routed through the
//! same `build_loaded_schema` helper so the catalog and column descriptors
//! are derived from a single source map and cannot drift.
//!
//! ## Collection mode — `__sql_schemas`
//!
//! The `__sql_schemas` collection holds one document per collection in the
//! database, shaped like:
//!
//! ```json
//! {
//!   "_id": "<collection_name>",
//!   "schema": {
//!     "version": 1,
//!     "jsonSchema": { "bsonType": "object", "properties": { ... } }
//!   }
//! }
//! ```
//!
//! `jsonSchema` is the per-collection JSON Schema (rooted at `bsonType: object`
//! with the field-level `properties`). The version field is currently always
//! 1; we accept it permissively but warn on mismatch (see `SUPPORTED_SCHEMA_VERSION`).
//!
//! ## File mode — YAML / JSON on disk
//!
//! YAML or JSON, single document, top-level `schema.jsonSchema.properties` map
//! whose keys are *collection names* and values are per-collection JSON
//! Schemas (the same body that appears under `schema.jsonSchema` in
//! Collection-mode). See SPEC.md §5.3 and ARCHITECTURE.md §3.4.
//!
//! ```yaml
//! schema:
//!   version: 1
//!   jsonSchema:
//!     bsonType: object
//!     properties:
//!       users:   { bsonType: object, properties: { ... } }
//!       orders:  { bsonType: object, properties: { ... } }
//! ```
//!
//! The file format does NOT carry a database name. File-mode loaders therefore
//! key the resulting `Catalog` under [`FILE_MODE_DB_PLACEHOLDER`] (currently
//! the empty string). The napi-rs surface (T09) MUST either pass that same
//! placeholder as `current_db` to `mongosql::translate_sql` for file-mode
//! callers, or rebuild the catalog under the configured database name before
//! caching. See Discoveries 2026-05-09 — T05.
//!
//! ## Atlas SQL mode — `sqlGetSchema` command
//!
//! Atlas SQL endpoints (`<cluster>-<id>.a.query.mongodb.net`) do NOT expose
//! `__sql_schemas` as a queryable collection. Schemas live in an internal
//! store fronted by the `sqlGetSchema` admin-style command. Per the canonical
//! spec at <https://www.mongodb.com/docs/sql-interface/schema/view/>:
//!
//! Request (run against the *target* database, not `admin`):
//!
//! ```json
//! { "sqlGetSchema": "<collection-or-view-name>" }
//! ```
//!
//! Response shape when a schema exists:
//!
//! ```json
//! {
//!   "ok": 1,
//!   "metadata": { "description": "<text>" },
//!   "schema":   { "version": 1, "jsonSchema": { ... } }
//! }
//! ```
//!
//! Response shape when no schema exists:
//!
//! ```json
//! { "ok": 1, "metadata": {}, "schema": {} }
//! ```
//!
//! `ok: 1` does NOT imply a schema was found — an empty `schema` object means
//! "no schema for this name" and that collection is skipped (not errored).
//!
//! There is NO `sqlListSchemas` command. Enumeration is `listCollections`
//! plus a per-collection `sqlGetSchema`. System collections (anything matching
//! the `system.*` prefix) and `__sql_schemas` itself are filtered out before
//! we call `sqlGetSchema` — they never carry catalog-relevant schemas and
//! would just generate noise.
//!
//! Per-collection `sqlGetSchema` calls are fanned out with bounded parallelism
//! (see [`ATLAS_SQL_FAN_OUT_CONCURRENCY`]) via `futures::stream::try_buffered`,
//! so refresh latency on a database with N collections is roughly
//! `ceil(N / CONCURRENCY) × RTT` rather than `N × RTT`. The concurrency cap
//! is deliberately conservative so refreshes don't hammer the Atlas SQL
//! control plane on databases with hundreds of collections.
//!
//! The fan-out short-circuits on the first `Err`. The previous shape used
//! `.buffered(N).collect::<Vec<_>>().await` and then `.collect::<Result<_,_>>()?`,
//! which drained the entire input even after one call failed — on a
//! 200-collection database wrongly pointed at a non-Atlas-SQL endpoint that
//! meant 200 RTTs of `CommandNotFound` errors before the same error surfaced.
//! Using `try_buffered` bounds the misconfiguration surface time by
//! `concurrency` rather than by `N`.
//!
//! ### Required Atlas role grants
//!
//! `sqlGetSchema` requires the connecting user to hold either the built-in
//! `atlasAdmin` role (on the Atlas project) OR a database-user role
//! combination granting `clusterMonitor` (on `admin`) plus `readAnyDatabase`
//! (on `admin`). A user who can `listCollections` but lacks `sqlGetSchema`
//! privileges will surface a MongoDB error code 13 (`Unauthorized`); the
//! loader detects this and emits a hint embedding those role names directly
//! plus a pointer to the Atlas operator-facing user/role configuration page
//! (rather than the misleading "wrong endpoint" message).
//!
//! No single canonical MongoDB docs page lists "atlasAdmin / clusterMonitor /
//! readAnyDatabase are what `sqlGetSchema` requires" — the privilege table
//! lives in the dynamically-rendered built-in-roles reference and is
//! unstable to deep-link. We therefore embed the role names in the error
//! message itself and cite
//! <https://www.mongodb.com/docs/atlas/security-add-mongodb-users/> as the
//! operationally-relevant landing page (this is where Atlas users actually
//! edit database-user roles via "Project → Security → Database Access").
//!
//! ## Trust boundary
//!
//! `load_from_file` uses the caller-supplied path as-is. No path-traversal
//! mitigation is performed by the loader; it is the caller's responsibility
//! to validate the path against any policy (e.g. confining to a designated
//! schema directory). The file is opened with the process's privileges.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use bson::{doc, Document};
use futures_util::{stream, StreamExt, TryStreamExt};
use mongosql::{
    build_catalog_from_catalog_schema,
    catalog::Catalog,
    json_schema::{self, BsonType, BsonTypeName, Schema as JsonSchema},
};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::error::{redact_uri_creds, Error, Result};

/// Maximum number of in-flight `sqlGetSchema` calls per refresh. Picked to
/// balance two pressures:
///
/// * **Refresh latency** — refresh time is `ceil(N / CONCURRENCY) × RTT`. With
///   typical Atlas RTTs of 50–150 ms and 100+ user collections, raising
///   concurrency from 1 to 8 cuts refresh time by ~8×.
/// * **Atlas server load** — each `sqlGetSchema` is an admin-style command on
///   the Atlas SQL control plane. Atlas does not publish a hard per-connection
///   rate cap for this command, but staying well below it (single-digit
///   concurrency) avoids triggering server-side throttling and leaves
///   headroom for other tenants on the same cluster.
///
/// 8 is conservative; tune upward if refresh latency on multi-hundred-
/// collection databases becomes a problem. We deliberately do NOT make this
/// configurable from `ClientConfig` yet — no caller has needed to tune it,
/// and exposing a knob too early just creates a footgun.
pub(crate) const ATLAS_SQL_FAN_OUT_CONCURRENCY: usize = 8;

/// MongoDB server error code for `Unauthorized` (insufficient role / privilege).
/// Surface-equivalent of `AuthorizationFailure` for runCommand. The full code
/// table lives at <https://github.com/mongodb/mongo/blob/master/src/mongo/base/error_codes.yml>.
pub(crate) const MONGO_ERROR_CODE_UNAUTHORIZED: i32 = 13;

/// MongoDB server error code for `CommandNotFound`. Surfaced when an endpoint
/// doesn't implement `sqlGetSchema` — the canonical signal that atlas-sql
/// mode is pointed at a regular MongoDB endpoint instead of an Atlas SQL one.
pub(crate) const MONGO_ERROR_CODE_COMMAND_NOT_FOUND: i32 = 59;

/// Atlas operator-facing database-user configuration URL, embedded in the
/// hint string when `sqlGetSchema` fails with `Unauthorized`.
///
/// The previous constant pointed at the Atlas SQL "Server Setup" / "Getting
/// Started" page, which does NOT actually list the role-grant requirements
/// (`atlasAdmin` / `clusterMonitor` / `readAnyDatabase`). An operator
/// following that link would be misled. MongoDB's docs do not publish a
/// single deep-linkable page that lists "these are the roles needed to run
/// sqlGetSchema" — the privilege table lives in the dynamically-rendered
/// built-in-roles reference which is unstable to deep-link.
///
/// The hint message therefore embeds the canonical role names directly
/// (operator does not need to traverse to docs) and points at this URL — the
/// Atlas "Configure Database Users" page — as the page where the operator
/// actually performs the fix ("Project → Security → Database Access → Edit
/// user → custom role grants").
pub(crate) const ATLAS_SQL_ROLES_DOC_URL: &str =
    "https://www.mongodb.com/docs/atlas/security-add-mongodb-users/";

/// Re-export of the upstream catalog so other modules don't import `mongosql`
/// directly. T07 (translate wrapper) consumes this.
pub type MongoSqlCatalog = Catalog;

/// One column descriptor as exposed in Cube's `tablesSchema` shape.
/// `name` is the field key from the per-collection JSON Schema; `sql_type`
/// is the BSON-type → SQL-type mapping (see [`bson_type_to_sql_type`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnInfo {
    /// Column name as it appears in the JSON Schema `properties` map.
    pub name: String,
    /// SQL-equivalent type label (e.g. `"string"`, `"int"`, `"timestamp"`).
    pub sql_type: String,
}

/// Per-`(db, collection)` ordered list of [`ColumnInfo`]. Used by the napi-rs
/// surface (T09) to produce Cube's nested `{db: {tbl: [...]}}` introspection
/// payload without having to introspect the opaque [`Catalog`].
pub type TableColumns = BTreeMap<(String, String), Vec<ColumnInfo>>;

/// Loaded schema bundle: the catalog the translator consumes plus the
/// parallel column-info structure the napi-rs `tables_schema` method renders.
///
/// Both are derived from the same `BTreeMap<db, BTreeMap<coll, JsonSchema>>`
/// so they cannot drift; clients only see them via `MongoSqlClient`.
#[derive(Debug)]
pub struct LoadedSchema {
    /// Catalog for `mongosql::translate_sql`.
    pub catalog: MongoSqlCatalog,
    /// Column descriptors keyed by `(db, collection)`.
    pub columns: TableColumns,
}

/// Name of the collection that holds the per-collection JSON Schemas.
/// Matches what the Atlas SQL Interface sampler and EA Schema Builder write.
#[allow(dead_code)] // referenced by other crate modules in T06+; visible to tests today
pub const SQL_SCHEMAS_COLLECTION: &str = "__sql_schemas";

/// Schema document `version` field that this driver targets. Documents with
/// other versions are accepted but produce a tracing warning, since the
/// upstream sampler may evolve the wire format independently of the
/// `jsonSchema` payload.
pub const SUPPORTED_SCHEMA_VERSION: i64 = 1;

/// Database-name placeholder used when [`load_from_file`] builds a catalog
/// from a file that has no database identifier in its envelope. See module
/// docs ("File-mode envelope") and Discoveries.
pub const FILE_MODE_DB_PLACEHOLDER: &str = "";

/// Atomic schema cache. Reads clone an `Arc<MongoSqlCatalog>` cheaply; writes
/// take a brief write lock to swap the inner pointer.
///
/// Stored as `Arc<RwLock<Arc<Catalog>>>` so the `RwLock` is just used for the
/// pointer swap — readers do not hold the lock across query execution.
#[allow(dead_code)] // wired into MongoSqlClient by T06/T09; exercised by tests today
#[derive(Clone, Default)]
pub struct SchemaCache {
    inner: Arc<RwLock<Arc<MongoSqlCatalog>>>,
}

#[allow(dead_code)] // see SchemaCache attribute
impl SchemaCache {
    /// Constructs an empty cache containing a `Catalog::default()`.
    pub fn new_empty() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Arc::new(Catalog::default()))),
        }
    }

    /// Returns a clone of the current catalog `Arc`. Cheap; does not hold the
    /// lock past the function return.
    pub fn read(&self) -> Arc<MongoSqlCatalog> {
        // Lock poisoning would only happen if a writer panicked while holding
        // the lock; in that case we surface the previous (still-valid) catalog
        // because the inner Arc was already swapped in or never replaced.
        match self.inner.read() {
            Ok(guard) => Arc::clone(&guard),
            Err(poisoned) => Arc::clone(&poisoned.into_inner()),
        }
    }

    /// Atomically replaces the cached catalog with `new`.
    pub fn write(&self, new: Arc<MongoSqlCatalog>) {
        match self.inner.write() {
            Ok(mut guard) => *guard = new,
            Err(poisoned) => *poisoned.into_inner() = new,
        }
    }
}

/// Maps a BSON type from a `json_schema::Schema` field declaration to the
/// SQL-type label exposed via Cube's `tablesSchema`. Cube doesn't enforce a
/// fixed vocabulary here, but its measure/dimension type-coercion code knows
/// the labels below — `string`, `int`, `decimal`, `timestamp`, `boolean`,
/// `double`, `object`, `array` — so we hew to that set.
///
/// - `Null` and unknown / missing types fall back to `"string"` (the safest
///   coercion for downstream SQL emission).
/// - Multiple-typed fields (e.g. `["string", "null"]`) collapse to the first
///   non-`null` entry; if all entries are `null`, returns `"string"`.
pub(crate) fn bson_type_to_sql_type(bt: Option<&BsonType>) -> String {
    match bt {
        None => "string".to_string(),
        Some(BsonType::Single(name)) => bson_type_name_to_sql(*name).to_string(),
        Some(BsonType::Multiple(names)) => {
            // Pick the first non-null variant; default to `"string"` if the
            // list is empty or all-null.
            for name in names {
                if !matches!(name, BsonTypeName::Null) {
                    return bson_type_name_to_sql(*name).to_string();
                }
            }
            "string".to_string()
        }
    }
}

fn bson_type_name_to_sql(name: BsonTypeName) -> &'static str {
    match name {
        BsonTypeName::String => "string",
        BsonTypeName::ObjectId => "string",
        BsonTypeName::Symbol => "string",
        BsonTypeName::Regex => "string",
        BsonTypeName::Javascript => "string",
        BsonTypeName::JavascriptWithScope => "string",
        BsonTypeName::DbPointer => "string",
        BsonTypeName::BinData => "string",
        BsonTypeName::Int => "int",
        // Long is BSON NumberLong (Int64). Mapping to "bigint" preserves the
        // full i64 range — collapsing to "int" silently truncates / mis-tags
        // values past i32::MAX downstream in Cube Store column-type tracking.
        BsonTypeName::Long => "bigint",
        BsonTypeName::Double => "double",
        BsonTypeName::Decimal => "decimal",
        BsonTypeName::Bool => "boolean",
        BsonTypeName::Date => "timestamp",
        BsonTypeName::Timestamp => "timestamp",
        BsonTypeName::Object => "object",
        BsonTypeName::Array => "array",
        // `null`, `undefined`, `minKey`, `maxKey` — degenerate / legacy.
        BsonTypeName::Null
        | BsonTypeName::Undefined
        | BsonTypeName::MinKey
        | BsonTypeName::MaxKey => "string",
    }
}

/// Walks `properties` on a per-collection JSON Schema and produces the
/// ordered column list. Order is alphabetical (BTreeMap iteration) for
/// determinism — the upstream `HashMap` has no defined order, but Cube's
/// consumers don't care about column ordering for introspection.
fn columns_from_collection_schema(schema: &JsonSchema) -> Vec<ColumnInfo> {
    let mut by_name: BTreeMap<String, ColumnInfo> = BTreeMap::new();
    if let Some(props) = &schema.properties {
        for (name, sub) in props {
            by_name.insert(
                name.clone(),
                ColumnInfo {
                    name: name.clone(),
                    sql_type: bson_type_to_sql_type(sub.bson_type.as_ref()),
                },
            );
        }
    }
    by_name.into_values().collect()
}

/// Build the `(catalog, columns)` pair from a `BTreeMap<db, BTreeMap<coll, Schema>>`.
/// Both branches of `load_*_with_columns` share this so the two outputs are
/// always derived from the same source map.
fn build_loaded_schema(
    by_db: BTreeMap<String, BTreeMap<String, JsonSchema>>,
) -> Result<LoadedSchema> {
    let mut columns: TableColumns = BTreeMap::new();
    for (db, by_coll) in &by_db {
        for (coll, schema) in by_coll {
            columns.insert(
                (db.clone(), coll.clone()),
                columns_from_collection_schema(schema),
            );
        }
    }
    let catalog = build_catalog_from_catalog_schema(by_db).map_err(|e| Error::SchemaInvalid {
        msg: format!("catalog build failed: {e}"),
    })?;
    Ok(LoadedSchema { catalog, columns })
}

/// Like [`load_from_collection`] but also returns the [`TableColumns`] map
/// the napi surface uses for `tables_schema()`. Tests for the catalog-only
/// loader continue to use [`load_from_collection`] unchanged.
pub async fn load_from_collection_with_columns(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<LoadedSchema> {
    let by_db = collect_collection_docs(client, db_name).await?;
    build_loaded_schema(by_db)
}

/// Like [`load_from_file`] but also returns the [`TableColumns`] map. The
/// catalog is keyed under [`FILE_MODE_DB_PLACEHOLDER`] (no db name in file
/// envelope); the same key is used in the returned `TableColumns`. Callers
/// (T09) re-key under `config.database` before exposing through `tables_schema()`.
pub fn load_from_file_with_columns(path: &std::path::Path) -> Result<LoadedSchema> {
    let by_db = collect_file_docs(path)?;
    build_loaded_schema(by_db)
}

/// Atlas-SQL-mode loader. Enumerates collections in `db_name`, filters out
/// system collections + `__sql_schemas`, then issues `sqlGetSchema` per
/// remaining name. Collections whose response has an empty `schema` object
/// are SKIPPED (not errored) — per the canonical Atlas SQL docs an empty
/// schema body means "no schema set for this name", which is a normal state.
///
/// The catalog is keyed under `db_name` (same as Collection mode); no
/// placeholder rewriting is needed downstream.
///
/// Errors surface as [`Error::SchemaInvalid`] when:
/// - `listCollections` succeeds but `sqlGetSchema` returns an explicit
///   error document (the canonical "command not recognised" case for a
///   non-Atlas-SQL endpoint mistakenly configured in this mode);
/// - any non-empty schema fails to parse.
///
/// An empty database (`listCollections` returns nothing) is NOT an error —
/// it yields an empty catalog and the periodic refresh task will pick up
/// any later additions.
pub async fn load_from_atlas_sql_with_columns(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<LoadedSchema> {
    let by_db = collect_atlas_sql_docs(client, db_name).await?;
    build_loaded_schema(by_db)
}

/// Read `__sql_schemas` from `db_name` and produce the same
/// `BTreeMap<db, BTreeMap<coll, Schema>>` shape `load_from_collection`
/// builds internally. Factored out so `load_from_collection_with_columns`
/// can reuse the I/O without duplicating it.
async fn collect_collection_docs(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<BTreeMap<String, BTreeMap<String, JsonSchema>>> {
    if db_name.trim().is_empty() {
        return Err(Error::ConfigInvalid {
            field: "database",
            reason: "empty".to_string(),
        });
    }

    let coll = client
        .database(db_name)
        .collection::<Document>(SQL_SCHEMAS_COLLECTION);

    let cursor = coll.find(doc! {}).await?;
    let docs: Vec<Document> = cursor.try_collect().await?;

    if docs.is_empty() {
        return Err(Error::SchemaNotFound {
            msg: format!("collection `{SQL_SCHEMAS_COLLECTION}` in database `{db_name}` is empty",),
        });
    }

    let mut by_collection: BTreeMap<String, JsonSchema> = BTreeMap::new();
    for doc in docs {
        let (name, schema) = parse_schema_document(doc)?;
        by_collection.insert(name, schema);
    }

    let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
    by_db.insert(db_name.to_string(), by_collection);
    Ok(by_db)
}

/// Atlas-SQL-mode I/O: enumerate user collections in `db_name` and call
/// `sqlGetSchema` per name. Returns the same `BTreeMap<db, BTreeMap<coll, Schema>>`
/// shape `collect_collection_docs` builds so the rest of the pipeline is
/// identical.
///
/// Filters applied BEFORE calling `sqlGetSchema`:
/// - any name starting with `system.` (e.g. `system.views`, `system.profile`);
/// - `__sql_schemas` itself (it never has its own `sqlGetSchema` entry).
///
/// `sqlGetSchema` is then called per remaining collection. Responses are
/// fed into [`parse_atlas_sql_response`], a pure function over `bson::Document`
/// that returns `Option<(name, schema)>` — `None` means "skip this collection
/// (no schema available)", which is the canonical empty-`schema`-object case.
async fn collect_atlas_sql_docs(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<BTreeMap<String, BTreeMap<String, JsonSchema>>> {
    if db_name.trim().is_empty() {
        return Err(Error::ConfigInvalid {
            field: "database",
            reason: "empty".to_string(),
        });
    }

    let database = client.database(db_name);
    let names = database
        .list_collection_names()
        .await
        .map_err(|e| map_list_collections_error(db_name, e))?;

    // Build one future per user-visible collection name (system + internal
    // names filtered out) and drive them through a buffered stream so up to
    // `ATLAS_SQL_FAN_OUT_CONCURRENCY` `sqlGetSchema` calls are in flight at
    // once. This turns a serial `N × RTT` refresh into roughly
    // `ceil(N / CONCURRENCY) × RTT` without giving up the per-call error
    // handling the serial loop had — each future still returns a typed
    // `Result<Option<(name, schema)>>` keyed by collection name. The helper
    // short-circuits on the first `Err`, so a misconfiguration (e.g.
    // atlas-sql mode pointed at a regular cluster) surfaces in `O(concurrency)`
    // RTTs rather than `O(N)`.
    let filtered: Vec<String> = names
        .into_iter()
        .filter(|n| !is_system_or_internal_collection(n))
        .collect();

    let database = Arc::new(database);
    let db_name_owned = db_name.to_string();
    let per_collection_futures = filtered.into_iter().map(|name| {
        let database = Arc::clone(&database);
        let db_name = db_name_owned.clone();
        async move { fetch_one_atlas_sql_schema(&database, &db_name, name).await }
    });

    let pairs: Vec<(String, Option<(String, JsonSchema)>)> =
        bounded_fan_out(per_collection_futures, ATLAS_SQL_FAN_OUT_CONCURRENCY).await?;

    let mut by_collection: BTreeMap<String, JsonSchema> = BTreeMap::new();
    for (orig_name, outcome) in pairs {
        match outcome {
            Some((coll_name, schema)) => {
                by_collection.insert(coll_name, schema);
            }
            None => {
                // Empty-schema response — collection has no Atlas SQL schema set.
                tracing::debug!(
                    target: "mongosql_driver::schema",
                    db = db_name,
                    collection = orig_name.as_str(),
                    "sqlGetSchema returned an empty schema document; skipping collection",
                );
            }
        }
    }

    let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
    by_db.insert(db_name.to_string(), by_collection);
    Ok(by_db)
}

/// Issue `sqlGetSchema` for exactly one collection and parse the response.
/// Returns `(original_name, Option<(parsed_name, schema)>)` so the caller can
/// log the original name on the `None` (empty-schema-skipped) path without
/// re-threading the input list. Errors are mapped through
/// [`map_run_command_error`] so the URI-redaction story stays centralised
/// and Unauthorized vs CommandNotFound get distinct, actionable hints.
async fn fetch_one_atlas_sql_schema(
    database: &mongodb::Database,
    db_name: &str,
    name: String,
) -> Result<(String, Option<(String, JsonSchema)>)> {
    let cmd = doc! {"sqlGetSchema": &name};
    let response = database
        .run_command(cmd)
        .await
        .map_err(|e| map_run_command_error(db_name, &name, e))?;
    let parsed = parse_atlas_sql_response(&name, response)?;
    Ok((name, parsed))
}

/// Drive `futures` (each yielding `Result<T, E>`) to completion with at most
/// `concurrency` in-flight at any moment, preserving the input iteration order
/// in the returned `Vec<T>`. Short-circuits on the first `Err`: once any
/// in-flight future yields an `Err(e)`, no new futures are pulled from the
/// input iterator and the helper returns `Err(e)` as soon as the
/// already-in-flight window winds down (which is bounded by `concurrency`,
/// not by input length).
///
/// Pulled out of [`collect_atlas_sql_docs`] as a stand-alone async function
/// so unit tests can exercise both fan-out fairness and short-circuit
/// semantics independently of mongo I/O — see
/// `tests::bounded_fan_out_runs_in_parallel_up_to_limit` and
/// `tests::bounded_fan_out_short_circuits_on_first_error`.
///
/// **Why short-circuit?** The previous variant returned `Vec<Result<T, E>>`
/// and the caller did `.collect::<Result<_, _>>()?`, but `buffered(N)`
/// continues polling input futures even after one produces an `Err`. On a
/// 200-collection database wrongly pointed at a non-Atlas-SQL endpoint the
/// old shape drained all 200 `sqlGetSchema` calls before surfacing the same
/// CommandNotFound error (~`200/N` RTTs at concurrency=8). `try_buffered`
/// terminates the stream after the first error so the misconfiguration
/// surface time is bounded by `concurrency`, not by `N`.
pub(crate) async fn bounded_fan_out<F, T, E, I>(
    futures: I,
    concurrency: usize,
) -> std::result::Result<Vec<T>, E>
where
    I: IntoIterator<Item = F>,
    F: std::future::Future<Output = std::result::Result<T, E>>,
{
    // `try_buffered` preserves input order in its output stream and aborts on
    // the first `Err`. Concurrency-clamping at 1 degenerates to serial
    // execution; clamp at 0 is treated as 1 so callers don't deadlock on a
    // misconfiguration.
    let concurrency = concurrency.max(1);
    stream::iter(futures)
        .map(Ok::<F, E>)
        .try_buffered(concurrency)
        .try_collect::<Vec<_>>()
        .await
}

/// Map a `mongodb::error::Error` from the `listCollections` call into the
/// driver's error taxonomy. Keeps the existing Authentication-→-AuthFailed
/// special case but routes all other variants through `redact_uri_creds` so
/// a future mongodb-crate variant whose Display embeds the connection URI
/// can't leak credentials into our public error message.
///
/// Splits classification from message-building so a unit test can exercise
/// the redaction-on-other-variants path without having to construct a
/// real `mongodb::error::Error` (whose inner kinds are `#[non_exhaustive]`).
fn map_list_collections_error(db_name: &str, e: mongodb::error::Error) -> Error {
    use mongodb::error::ErrorKind;
    let is_auth = matches!(e.kind.as_ref(), ErrorKind::Authentication { .. });
    let inner = format!("{}", e.kind);
    build_list_collections_error_message(db_name, is_auth, &inner)
}

/// Build the typed `Error` for a failed `listCollections` call. Exposed at
/// crate scope so tests can hit both the Authentication-branch and the
/// generic redacted-Other branch with synthetic inputs.
pub(crate) fn build_list_collections_error_message(
    db_name: &str,
    is_authentication_error: bool,
    inner_message: &str,
) -> Error {
    if is_authentication_error {
        Error::AuthFailed {
            msg: "authentication handshake rejected by server".to_string(),
        }
    } else {
        let inner = redact_uri_creds(inner_message);
        Error::SchemaInvalid {
            msg: format!("listCollections failed on database `{db_name}`: {inner}"),
        }
    }
}

/// Map a `mongodb::error::Error` from a per-collection `sqlGetSchema` call.
///
/// Inspects the `mongodb::error::ErrorKind` enough to extract a stable
/// classification (server-side `Command` errors with their `code`, vs.
/// non-command errors) and then defers to [`build_run_command_error_message`]
/// for the actual `Error::SchemaInvalid` construction. The split lets the
/// unit tests cover every branch by code without needing to construct a
/// `mongodb::error::Error::Command` from outside the mongodb crate (which
/// is impossible because `CommandError` is `#[non_exhaustive]`).
fn map_run_command_error(db_name: &str, name: &str, e: mongodb::error::Error) -> Error {
    use mongodb::error::ErrorKind;
    let class = match e.kind.as_ref() {
        ErrorKind::Command(cmd_err) => RunCommandErrorClass::CommandCode(cmd_err.code),
        _ => RunCommandErrorClass::Other,
    };
    let inner = format!("{}", e.kind);
    build_run_command_error_message(db_name, name, class, &inner)
}

/// Stable classification of a `mongodb::error::Error` from
/// `database.run_command(...)`. Decoupled from the upstream non-exhaustive
/// types so the message-builder can be driven by tests with synthetic inputs.
#[derive(Debug, Clone, Copy)]
pub(crate) enum RunCommandErrorClass {
    /// A `CommandError` with the given server-side numeric code. The two
    /// codes the loader specifically branches on are
    /// [`MONGO_ERROR_CODE_UNAUTHORIZED`] (13) and
    /// [`MONGO_ERROR_CODE_COMMAND_NOT_FOUND`] (59); any other code is
    /// reported as a generic command failure.
    CommandCode(i32),
    /// Not a command error — IO / DNS / TLS / etc. The full mongodb-crate
    /// Display string is included in the public message *after* being routed
    /// through [`redact_uri_creds`].
    Other,
}

/// Build the `Error::SchemaInvalid` returned for a failed `sqlGetSchema` call.
///
/// Three branches:
/// 1. `CommandCode(13)` (Unauthorized) — emit a hint pointing at
///    [`ATLAS_SQL_ROLES_DOC_URL`]. The connecting user can `listCollections`
///    but cannot `sqlGetSchema`; the canonical fix is to grant `atlasAdmin`
///    or (`clusterMonitor` + `readAnyDatabase`).
/// 2. `CommandCode(59)` (CommandNotFound) — emit a hint that the endpoint
///    doesn't speak `sqlGetSchema` (the user has pointed atlas-sql mode at a
///    regular MongoDB endpoint instead of the SQL-front).
/// 3. Anything else (other command codes, IO/DNS/TLS/etc.) — generic hint,
///    with the underlying message routed through `redact_uri_creds`.
pub(crate) fn build_run_command_error_message(
    db_name: &str,
    name: &str,
    class: RunCommandErrorClass,
    inner_message: &str,
) -> Error {
    match class {
        RunCommandErrorClass::CommandCode(code) if code == MONGO_ERROR_CODE_UNAUTHORIZED => {
            // Don't include the server-side errmsg here: it can include
            // namespace + user identifiers we'd rather keep out of the
            // surfaced Cube error. The actionable info is the doc URL.
            Error::SchemaInvalid {
                msg: format!(
                    "sqlGetSchema for `{db_name}.{name}` was rejected with code 13 (Unauthorized) \
                     — the connecting user is not authorized to run sqlGetSchema. \
                     Atlas SQL requires the `atlasAdmin` role on the Atlas project, \
                     OR a database-user combination granting `clusterMonitor` (on `admin`) \
                     + `readAnyDatabase` (on `admin`). \
                     Configure via the Atlas UI: Project → Security → Database Access → \
                     Edit user. See {ATLAS_SQL_ROLES_DOC_URL} for general user/role configuration.",
                ),
            }
        }
        RunCommandErrorClass::CommandCode(code) if code == MONGO_ERROR_CODE_COMMAND_NOT_FOUND => {
            Error::SchemaInvalid {
                msg: format!(
                    "sqlGetSchema for `{db_name}.{name}` was rejected with code 59 \
                     (CommandNotFound) — this endpoint does not implement sqlGetSchema. \
                     atlas-sql mode requires an Atlas SQL endpoint \
                     (host pattern: `*.a.query.mongodb.net`); use collection mode for \
                     regular MongoDB clusters that seed `__sql_schemas`",
                ),
            }
        }
        _ => {
            let inner = redact_uri_creds(inner_message);
            Error::SchemaInvalid {
                msg: format!(
                    "sqlGetSchema for `{db_name}.{name}` failed: {inner} \
                     — atlas-sql mode requires an Atlas SQL endpoint \
                     (sqlGetSchema is not supported by general-purpose MongoDB endpoints)",
                ),
            }
        }
    }
}

/// Returns `true` for collection names that must be excluded from
/// `sqlGetSchema` enumeration: anything matching the MongoDB `system.*`
/// reserved prefix, and the `__sql_schemas` collection itself (Atlas SQL
/// stores its catalog out-of-band so this name is meaningless here, but
/// some clusters carry a stale copy).
fn is_system_or_internal_collection(name: &str) -> bool {
    name.starts_with("system.") || name == SQL_SCHEMAS_COLLECTION
}

/// Parse a `sqlGetSchema` response document.
///
/// Pure helper extracted from [`collect_atlas_sql_docs`] so that unit tests
/// can drive every code path with mock `bson::Document` values without a
/// live MongoDB connection. Mirrors the response shape documented at
/// <https://www.mongodb.com/docs/sql-interface/schema/view/>:
///
/// - `{ok: 1, metadata: {}, schema: {}}` → `Ok(None)` (no schema set; skip).
/// - `{ok: 1, metadata: {...}, schema: {version, jsonSchema}}` →
///   `Ok(Some((collection, parsed_schema)))`.
/// - `{ok: 0, ...}` (error reply) → `Err(SchemaInvalid)` with the upstream
///   `errmsg` if present, suggesting that the endpoint may not support
///   `sqlGetSchema` (i.e. mis-configured atlas-sql mode against a regular
///   cluster).
/// - Anything else (missing `schema`, non-document `schema`, missing
///   `jsonSchema` inside, schema fails to parse) → `Err(SchemaInvalid)` with
///   the offending collection name embedded for diagnostics.
pub(crate) fn parse_atlas_sql_response(
    collection_name: &str,
    response: Document,
) -> Result<Option<(String, JsonSchema)>> {
    // An explicit `ok: 0` reply gets surfaced as SchemaInvalid. In practice
    // the mongodb crate raises this as an error and we never reach here,
    // but the doc-driven contract is "any non-1 ok means failure" — so be
    // explicit, since a future server version could return `ok: 0` without
    // tripping the crate's command-error path.
    if let Ok(ok) = response.get_f64("ok") {
        if ok != 1.0 {
            let errmsg = response
                .get_str("errmsg")
                .unwrap_or("server returned ok != 1");
            return Err(Error::SchemaInvalid {
                msg: format!(
                    "sqlGetSchema for `{collection_name}` failed: {errmsg} \
                     — atlas-sql mode requires an Atlas SQL endpoint"
                ),
            });
        }
    } else if let Ok(ok_i) = response.get_i32("ok") {
        if ok_i != 1 {
            let errmsg = response
                .get_str("errmsg")
                .unwrap_or("server returned ok != 1");
            return Err(Error::SchemaInvalid {
                msg: format!(
                    "sqlGetSchema for `{collection_name}` failed: {errmsg} \
                     — atlas-sql mode requires an Atlas SQL endpoint"
                ),
            });
        }
    }

    // Per spec the `schema` field is always present; an empty document
    // means "no schema set". Treat missing-`schema` the same as empty —
    // both result in "skip this collection".
    let schema_value = match response.get("schema") {
        Some(v) => v,
        None => return Ok(None),
    };
    let schema_doc = match schema_value {
        bson::Bson::Document(d) => d,
        bson::Bson::Null => return Ok(None),
        other => {
            return Err(Error::SchemaInvalid {
                msg: format!(
                    "sqlGetSchema for `{collection_name}`: `schema` must be a document, got `{:?}`",
                    other.element_type(),
                ),
            });
        }
    };

    if schema_doc.is_empty() {
        return Ok(None);
    }

    // Permissive version handling — matches Collection-mode convention.
    // Atlas SQL writes `version` as a NumberLong (BSON int64), but other
    // toolchains (EJSON-relaxed JSON imports, future Atlas server versions)
    // could ship it as Int32, Double, or — in degenerate cases — a String
    // or NumberDecimal. We *want* the mismatch warning to fire across all
    // numeric encodings so observability stays symmetric with the i64
    // happy path; only an unrecognised BSON type is logged at `debug` so
    // that operators inspecting traces can still see "we tried and gave up"
    // without it polluting the warn-level stream.
    check_schema_version(schema_doc, collection_name);

    let json_schema_doc =
        schema_doc
            .get_document("jsonSchema")
            .map_err(|_| Error::SchemaInvalid {
                msg: format!(
                "sqlGetSchema for `{collection_name}`: missing or non-document `schema.jsonSchema`"
            ),
            })?;

    let parsed = parse_collection_schema(collection_name, json_schema_doc)?;
    Ok(Some(parsed))
}

/// Read `schema.version` permissively and warn if it doesn't match
/// [`SUPPORTED_SCHEMA_VERSION`].
///
/// Called by all three schema-source loaders (collection mode, file mode,
/// atlas-sql mode) so the version-mismatch warn behaviour is symmetric
/// regardless of where the schema document originated. Each loader passes
/// its own attribution label (collection name for atlas-sql/collection mode,
/// file path for file mode).
///
/// The Atlas SQL endpoint encodes `version` as an int64 (NumberLong), but
/// permissive parsing covers Int32 and Double-with-integer-value as well —
/// some EJSON-relaxed JSON-import paths can produce either of those (file
/// mode is the most common entry point for EJSON-relaxed shapes, but
/// collection mode can hit them too if `__sql_schemas` was seeded by an
/// external loader). If `version` is present but parses to none of those
/// numeric forms, we emit a `debug` log noting the BSON type so operators
/// can spot a wire-format drift without it polluting the warn-level stream.
/// Missing `version` is also `debug` (rather than warn), matching the
/// existing permissive-on-missing convention.
pub(crate) fn check_schema_version(schema_doc: &Document, collection_name: &str) {
    let parsed_version: Option<i64> = if let Ok(v) = schema_doc.get_i64("version") {
        Some(v)
    } else if let Ok(v) = schema_doc.get_i32("version") {
        Some(v as i64)
    } else if let Ok(v) = schema_doc.get_f64("version") {
        // Cast only if the double cleanly represents an integer. A value like
        // 1.5 would be a wire-format violation, not a version-mismatch — log
        // as debug below rather than emit a misleading warn with a truncated
        // integer.
        if v.is_finite() && v.fract() == 0.0 {
            Some(v as i64)
        } else {
            None
        }
    } else {
        None
    };

    match parsed_version {
        Some(v) if v != SUPPORTED_SCHEMA_VERSION => {
            tracing::warn!(
                target: "mongosql_driver::schema",
                collection = collection_name,
                version = v,
                expected = SUPPORTED_SCHEMA_VERSION,
                "atlas-sql schema version mismatch; attempting to parse jsonSchema anyway",
            );
        }
        Some(_) => {
            // Matches expected version — no log.
        }
        None => {
            // `version` may be entirely absent (permitted; nothing to log) OR
            // present-but-non-numeric. Distinguish those so a wire-format
            // drift shows up in traces without surfacing on the warn path.
            if let Some(actual) = schema_doc.get("version") {
                tracing::debug!(
                    target: "mongosql_driver::schema",
                    collection = collection_name,
                    bson_type = ?actual.element_type(),
                    "atlas-sql schema `version` is present but not a recognised numeric type; skipping version check",
                );
            }
        }
    }
}

/// Read a YAML/JSON schema file from disk and produce the same
/// `BTreeMap<db, BTreeMap<coll, Schema>>` shape `load_from_file` builds
/// internally — keyed under [`FILE_MODE_DB_PLACEHOLDER`].
fn collect_file_docs(
    path: &std::path::Path,
) -> Result<BTreeMap<String, BTreeMap<String, JsonSchema>>> {
    if !path.exists() {
        return Err(Error::SchemaFileNotFound {
            path: path.to_path_buf(),
        });
    }

    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase);

    let format = match ext.as_deref() {
        Some("yaml") | Some("yml") => SchemaFileFormat::Yaml,
        Some("json") => SchemaFileFormat::Json,
        Some(other) => {
            return Err(Error::ConfigInvalid {
                field: "schema_file",
                reason: format!("unsupported extension '{other}'; expected .yaml/.yml/.json",),
            });
        }
        None => {
            return Err(Error::ConfigInvalid {
                field: "schema_file",
                reason: format!(
                    "missing file extension on `{}`; expected .yaml/.yml/.json",
                    path.display(),
                ),
            });
        }
    };

    let raw = std::fs::read_to_string(path).map_err(|e| Error::SchemaInvalid {
        msg: format!("failed to read `{}`: {e}", path.display()),
    })?;

    let envelope = parse_file_to_document(format, &raw, path)?;
    let collections = extract_collections_from_envelope(&envelope, path)?;

    if collections.is_empty() {
        return Err(Error::SchemaNotFound {
            msg: format!(
                "schema file `{}` has no entries under schema.jsonSchema.properties",
                path.display(),
            ),
        });
    }

    let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
    by_db.insert(FILE_MODE_DB_PLACEHOLDER.to_string(), collections);
    Ok(by_db)
}

/// Loads the schema from `__sql_schemas` in the configured database.
///
/// Returns `Error::SchemaNotFound` if the collection has no documents.
/// Returns `Error::SchemaInvalid { msg }` (with the offending collection name
/// embedded in `msg`) if any document fails to parse.
#[allow(dead_code)] // wired in by T09 (napi surface); exercised by integration test today
pub async fn load_from_collection(
    client: &mongodb::Client,
    db_name: &str,
) -> Result<MongoSqlCatalog> {
    if db_name.trim().is_empty() {
        return Err(Error::ConfigInvalid {
            field: "database",
            reason: "empty".to_string(),
        });
    }

    let coll = client
        .database(db_name)
        .collection::<Document>(SQL_SCHEMAS_COLLECTION);

    let cursor = coll.find(doc! {}).await?;
    let docs: Vec<Document> = cursor.try_collect().await?;

    if docs.is_empty() {
        return Err(Error::SchemaNotFound {
            msg: format!("collection `{SQL_SCHEMAS_COLLECTION}` in database `{db_name}` is empty",),
        });
    }

    let mut by_collection: BTreeMap<String, JsonSchema> = BTreeMap::new();
    for doc in docs {
        let (name, schema) = parse_schema_document(doc)?;
        by_collection.insert(name, schema);
    }

    let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
    by_db.insert(db_name.to_string(), by_collection);

    build_catalog_from_catalog_schema(by_db).map_err(|e| Error::SchemaInvalid {
        msg: format!("catalog build failed: {e}"),
    })
}

/// Parses a single `__sql_schemas` document into `(collection_name, schema)`.
///
/// Public to the crate so unit tests can drive it without a Mongo client. The
/// translated `Error::SchemaInvalid` always contains the collection name (or
/// the literal string `"<missing _id>"` when `_id` cannot be read).
pub(crate) fn parse_schema_document(mut doc: Document) -> Result<(String, JsonSchema)> {
    // _id may be either a String (the typical case for __sql_schemas) or any
    // other BSON value. We only support String; surface a clear error otherwise.
    let id_bson = doc.remove("_id").ok_or_else(|| Error::SchemaInvalid {
        msg: "<missing _id>: schema document is missing `_id`".to_string(),
    })?;
    let collection_name = match id_bson {
        bson::Bson::String(s) => s,
        other => {
            return Err(Error::SchemaInvalid {
                msg: format!(
                    "<non-string _id>: expected string `_id`, got BSON type `{:?}`",
                    other.element_type(),
                ),
            });
        }
    };

    let schema_value = doc.remove("schema").ok_or_else(|| Error::SchemaInvalid {
        msg: format!("collection `{collection_name}`: missing `schema` field"),
    })?;

    let schema_doc = match schema_value {
        bson::Bson::Document(d) => d,
        other => {
            return Err(Error::SchemaInvalid {
                msg: format!(
                    "collection `{collection_name}`: `schema` must be a document, got `{:?}`",
                    other.element_type(),
                ),
            });
        }
    };

    // version is informational; missing/wrong versions are accepted but
    // logged. Route through the permissive helper so Int32 / Double encodings
    // (from EJSON-relaxed JSON imports into `__sql_schemas`) get the same
    // warn-level mismatch treatment that atlas-sql mode emits — without it,
    // a `version: 99` document encoded as Int32 would silently skip the
    // warning.
    check_schema_version(&schema_doc, &collection_name);

    let json_schema_doc =
        schema_doc
            .get_document("jsonSchema")
            .map_err(|_| Error::SchemaInvalid {
                msg: format!(
                    "collection `{collection_name}`: missing or non-document `schema.jsonSchema`"
                ),
            })?;

    parse_collection_schema(&collection_name, json_schema_doc)
}

/// Parses a per-collection JSON Schema body into a typed `json_schema::Schema`.
///
/// Both the Collection-mode loader (`parse_schema_document`) and the
/// File-mode loader (`load_from_file`) call this helper. The `name` argument
/// is purely for error-message attribution; the returned `String` is
/// `name.to_string()` so the call sites can shovel it directly into the
/// `BTreeMap<collection, Schema>` without re-allocating from a foreign source.
pub(crate) fn parse_collection_schema(
    name: &str,
    json_schema: &Document,
) -> Result<(String, JsonSchema)> {
    let schema =
        json_schema::Schema::from_document(json_schema).map_err(|e| Error::SchemaInvalid {
            msg: format!("collection `{name}`: jsonSchema parse failed: {e}"),
        })?;
    Ok((name.to_string(), schema))
}

/// Loads schema from a YAML or JSON file on disk. Format is detected by
/// extension: `.yaml` / `.yml` → YAML; `.json` → JSON. Anything else errors
/// with [`Error::ConfigInvalid`].
///
/// The returned `Catalog` is keyed under [`FILE_MODE_DB_PLACEHOLDER`] (see
/// module docs).
///
/// Errors:
/// - [`Error::SchemaFileNotFound`] — the path does not exist.
/// - [`Error::ConfigInvalid`] — unsupported / missing extension.
/// - [`Error::SchemaInvalid`] — file is unreadable, fails to parse, or has the
///   wrong shape (missing `schema.jsonSchema.properties` etc).
/// - [`Error::SchemaNotFound`] — `schema.jsonSchema.properties` is empty.
#[allow(dead_code)] // wired in by T09 (napi surface); exercised by unit tests today
pub fn load_from_file(path: &std::path::Path) -> Result<MongoSqlCatalog> {
    if !path.exists() {
        return Err(Error::SchemaFileNotFound {
            path: path.to_path_buf(),
        });
    }

    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase);

    let format = match ext.as_deref() {
        Some("yaml") | Some("yml") => SchemaFileFormat::Yaml,
        Some("json") => SchemaFileFormat::Json,
        Some(other) => {
            return Err(Error::ConfigInvalid {
                field: "schema_file",
                reason: format!("unsupported extension '{other}'; expected .yaml/.yml/.json",),
            });
        }
        None => {
            return Err(Error::ConfigInvalid {
                field: "schema_file",
                reason: format!(
                    "missing file extension on `{}`; expected .yaml/.yml/.json",
                    path.display(),
                ),
            });
        }
    };

    // std::fs::read_to_string maps NotFound → io::ErrorKind::NotFound; via the
    // From<io::Error> impl that becomes SchemaFileNotFound but with an empty
    // path. We've already covered the missing-file case above with a populated
    // path, so any io error here is a *read* failure (permission, etc.).
    let raw = std::fs::read_to_string(path).map_err(|e| Error::SchemaInvalid {
        msg: format!("failed to read `{}`: {e}", path.display()),
    })?;

    let envelope = parse_file_to_document(format, &raw, path)?;
    let collections = extract_collections_from_envelope(&envelope, path)?;

    if collections.is_empty() {
        return Err(Error::SchemaNotFound {
            msg: format!(
                "schema file `{}` has no entries under schema.jsonSchema.properties",
                path.display(),
            ),
        });
    }

    let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
    by_db.insert(FILE_MODE_DB_PLACEHOLDER.to_string(), collections);

    build_catalog_from_catalog_schema(by_db).map_err(|e| Error::SchemaInvalid {
        msg: format!("catalog build failed: {e}"),
    })
}

#[derive(Copy, Clone)]
enum SchemaFileFormat {
    Yaml,
    Json,
}

/// Parse the raw file text into a `bson::Document` envelope. Both YAML and
/// JSON funnel through `serde_json::Value` first because:
///
/// 1. `bson::Bson::TryFrom<serde_json::Value>` is implemented and handles
///    the JSON → BSON value mapping we want for schema documents.
/// 2. `serde_yaml` deserializes into `serde_json::Value` cleanly for the
///    string-keyed YAML our schema format uses (see SPEC §5.3 / ARCHITECTURE
///    §3.4 — schema files only contain string keys and primitive scalars).
///
/// This guarantees byte-identical Catalogs for byte-identical content:
/// content equivalent in YAML and JSON parses to the same `serde_json::Value`,
/// which converts to the same `bson::Document`, which produces the same
/// `Catalog`.
fn parse_file_to_document(
    format: SchemaFileFormat,
    raw: &str,
    path: &std::path::Path,
) -> Result<Document> {
    let json_value: serde_json::Value = match format {
        SchemaFileFormat::Yaml => serde_yaml::from_str(raw).map_err(|e| Error::SchemaInvalid {
            msg: format!("failed to parse YAML at `{}`: {e}", path.display()),
        })?,
        SchemaFileFormat::Json => serde_json::from_str(raw).map_err(|e| Error::SchemaInvalid {
            msg: format!("failed to parse JSON at `{}`: {e}", path.display()),
        })?,
    };

    // The top level of a schema file MUST be an object — anything else
    // (array, scalar, null) is a malformed envelope.
    if !json_value.is_object() {
        return Err(Error::SchemaInvalid {
            msg: format!(
                "schema file `{}`: top level must be an object",
                path.display(),
            ),
        });
    }

    let bson_value: bson::Bson =
        bson::Bson::try_from(json_value).map_err(|e| Error::SchemaInvalid {
            msg: format!(
                "schema file `{}`: BSON conversion failed: {e}",
                path.display(),
            ),
        })?;

    match bson_value {
        bson::Bson::Document(d) => Ok(d),
        other => Err(Error::SchemaInvalid {
            msg: format!(
                "schema file `{}`: top level must be a document, got `{:?}`",
                path.display(),
                other.element_type(),
            ),
        }),
    }
}

/// Walks the file envelope and produces the per-collection schema map.
///
/// The envelope shape (see module docs) is:
/// `{ schema: { jsonSchema: { properties: { <coll>: <body> } } } }`.
/// Each `<body>` is a per-collection JSON Schema, parsed via the same
/// helper Collection-mode uses ([`parse_collection_schema`]).
fn extract_collections_from_envelope(
    envelope: &Document,
    path: &std::path::Path,
) -> Result<BTreeMap<String, JsonSchema>> {
    let schema_block = envelope
        .get_document("schema")
        .map_err(|_| Error::SchemaInvalid {
            msg: format!(
                "schema file `{}`: missing or non-document top-level `schema`",
                path.display(),
            ),
        })?;

    // Permissive version handling — same convention as Collection-mode and
    // atlas-sql mode. Route through the shared helper so Int32 / Double
    // encodings (common from EJSON-relaxed JSON files) get the same
    // warn-level treatment. Attribution uses `file:<path>` so that traces
    // can distinguish file-mode mismatches from collection-mode ones (the
    // helper logs the attribution under the `collection` field — the label
    // here is "where did this schema document come from", not literally a
    // collection name).
    let attribution = format!("file:{}", path.display());
    check_schema_version(schema_block, &attribution);

    let json_schema =
        schema_block
            .get_document("jsonSchema")
            .map_err(|_| Error::SchemaInvalid {
                msg: format!(
                    "schema file `{}`: missing or non-document `schema.jsonSchema`",
                    path.display(),
                ),
            })?;

    let properties = json_schema
        .get_document("properties")
        .map_err(|_| Error::SchemaInvalid {
            msg: format!(
                "schema file `{}`: missing or non-document `schema.jsonSchema.properties`",
                path.display(),
            ),
        })?;

    let mut by_collection: BTreeMap<String, JsonSchema> = BTreeMap::new();
    for (coll_name, coll_body) in properties.iter() {
        let coll_doc = match coll_body {
            bson::Bson::Document(d) => d,
            other => {
                return Err(Error::SchemaInvalid {
                    msg: format!(
                        "schema file `{}`: collection `{coll_name}` body must be a document, got `{:?}`",
                        path.display(),
                        other.element_type(),
                    ),
                });
            }
        };
        let (name, schema) = parse_collection_schema(coll_name, coll_doc)?;
        by_collection.insert(name, schema);
    }

    Ok(by_collection)
}

/// Handle returned by [`spawn_refresh_task`]. Owns the shutdown signal and the
/// background task's `JoinHandle`. Calling [`SchemaRefreshHandle::shutdown`]
/// notifies the task to stop and awaits its termination.
///
/// The handle deliberately does NOT auto-stop the task on drop — that would
/// detach the task instead, since `Drop` cannot await. Callers are expected to
/// call `shutdown().await` during graceful client teardown. If the handle is
/// dropped without `shutdown`, the task continues running until the process
/// exits.
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by tests today
pub struct SchemaRefreshHandle {
    shutdown: Arc<Notify>,
    join: JoinHandle<()>,
}

#[allow(dead_code)] // see SchemaRefreshHandle attribute
impl SchemaRefreshHandle {
    /// Signals the refresh task to stop and awaits its termination.
    ///
    /// Returns when the task has fully exited. If the task panicked, the
    /// `JoinError` is logged and discarded; we do not propagate panics from
    /// the background task into the shutdown caller.
    ///
    /// Uses `notify_one()` rather than `notify_waiters()` so the permit
    /// persists when the spawned task hasn't yet registered its first
    /// `notified()` future. `notify_waiters()` only wakes pre-existing
    /// waiters and is dropped on the floor if the task is still in the
    /// "spawned but not yet polled" state — which is exactly what happens
    /// when callers shut a client down immediately after `test_connection()`
    /// on a `current_thread` runtime.
    pub async fn shutdown(self) {
        self.shutdown.notify_one();
        if let Err(e) = self.join.await {
            tracing::warn!(
                target: "mongosql_driver::schema",
                error = %e,
                "schema refresh task did not exit cleanly",
            );
        }
    }
}

/// Spawn a Tokio task that calls `loader()` every `refresh_sec` seconds and
/// atomically swaps the `cache` on success.
///
/// Behaviour:
/// - The first refresh fires *after* `refresh_sec` elapses, not immediately.
///   `MongoSqlClient::test_connection()` is responsible for the initial load.
/// - On loader success: the new catalog is wrapped in `Arc` and written via
///   [`SchemaCache::write`] — readers observe the new pointer via the next
///   `read()` call.
/// - On loader failure: the error is logged at `WARN` (with the full chain via
///   `Display` on `Error`, which `thiserror` constructs). The previous cache
///   contents remain in place. The task continues, retrying at the next tick.
/// - Shutdown: the returned [`SchemaRefreshHandle`] holds a `Notify`. The task
///   exits cleanly when `shutdown().await` is called.
///
/// This intentionally uses an explicit `Notify` for shutdown rather than the
/// `Weak<Self>`-self-stop pattern: `Weak`-based stop forces the task to wake
/// up before it can detect the drop, which races with the refresh interval
/// and can leak the task for up to `refresh_sec` seconds. The `Notify` lets
/// shutdown interrupt the sleep immediately.
#[allow(dead_code)] // wired into MongoSqlClient by T09; exercised by tests today
pub fn spawn_refresh_task<F, Fut>(
    cache: SchemaCache,
    refresh_sec: u64,
    loader: F,
) -> SchemaRefreshHandle
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<MongoSqlCatalog>> + Send,
{
    let shutdown = Arc::new(Notify::new());
    let task_shutdown = Arc::clone(&shutdown);
    let interval = std::time::Duration::from_secs(refresh_sec);

    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = task_shutdown.notified() => {
                    tracing::debug!(
                        target: "mongosql_driver::schema",
                        "schema refresh task received shutdown",
                    );
                    return;
                }
                _ = tokio::time::sleep(interval) => {}
            }

            match loader().await {
                Ok(new_catalog) => {
                    cache.write(Arc::new(new_catalog));
                    tracing::debug!(
                        target: "mongosql_driver::schema",
                        "schema cache refreshed",
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        target: "mongosql_driver::schema",
                        error = %e,
                        "schema refresh failed; retaining stale cache, retrying next tick",
                    );
                }
            }
        }
    });

    SchemaRefreshHandle { shutdown, join }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agg_ast::definitions::Namespace;
    use bson::doc;

    /// Build a well-formed `__sql_schemas` document for a single collection.
    fn make_doc(name: &str, properties: Document) -> Document {
        doc! {
            "_id": name,
            "schema": {
                "version": 1_i64,
                "jsonSchema": {
                    "bsonType": "object",
                    "properties": properties,
                },
            },
        }
    }

    #[test]
    fn parse_schema_document_happy_path() {
        let doc = make_doc(
            "users",
            doc! {
                "_id": { "bsonType": "objectId" },
                "email": { "bsonType": "string" },
            },
        );
        let (name, schema) = parse_schema_document(doc).expect("valid doc parses");
        assert_eq!(name, "users");
        // The parsed schema should report `bson_type` of `object` and have two
        // properties.
        assert!(schema.bson_type.is_some());
        let props = schema.properties.expect("properties present");
        assert!(props.contains_key("email"));
        assert!(props.contains_key("_id"));
    }

    #[test]
    fn parse_schema_document_handles_decimal_and_date() {
        let doc = make_doc(
            "orders",
            doc! {
                "amount":     { "bsonType": "decimal" },
                "created_at": { "bsonType": "date" },
                "tags":       { "bsonType": "array", "items": { "bsonType": "string" } },
            },
        );
        let (name, schema) = parse_schema_document(doc).expect("valid doc parses");
        assert_eq!(name, "orders");
        let props = schema.properties.expect("properties present");
        assert!(props.contains_key("amount"));
        assert!(props.contains_key("created_at"));
        assert!(props.contains_key("tags"));
    }

    #[test]
    fn parse_schema_document_missing_id() {
        let doc = doc! { "schema": { "version": 1_i64, "jsonSchema": { "bsonType": "object" } } };
        match parse_schema_document(doc) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("_id"), "msg should mention _id, got: {msg}");
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_schema_document_non_string_id() {
        let doc = doc! { "_id": 42_i64, "schema": { "jsonSchema": { "bsonType": "object" } } };
        match parse_schema_document(doc) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("_id"), "msg should mention _id");
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_schema_document_missing_schema_field() {
        let doc = doc! { "_id": "users" };
        match parse_schema_document(doc) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("users"), "msg should mention collection name");
                assert!(msg.contains("schema"), "msg should mention schema");
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_schema_document_missing_jsonschema() {
        let doc = doc! {
            "_id": "users",
            "schema": { "version": 1_i64 },
        };
        match parse_schema_document(doc) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(
                    msg.contains("users"),
                    "msg should mention collection: {msg}"
                );
                assert!(
                    msg.contains("jsonSchema"),
                    "msg should mention jsonSchema: {msg}"
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_schema_document_non_document_schema() {
        let doc = doc! { "_id": "users", "schema": "not a document" };
        match parse_schema_document(doc) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("users"));
                assert!(msg.contains("schema"));
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_schema_document_accepts_unsupported_version() {
        // Version mismatch is permissive: parse continues but logs a warning.
        let doc = doc! {
            "_id": "users",
            "schema": {
                "version": 99_i64,
                "jsonSchema": { "bsonType": "object", "properties": {
                    "email": { "bsonType": "string" },
                }},
            },
        };
        let (name, schema) = parse_schema_document(doc).expect("permissive on version");
        assert_eq!(name, "users");
        assert!(schema.properties.is_some());
    }

    #[test]
    fn parse_schema_document_accepts_missing_version() {
        // Production __sql_schemas always carries `version`, but our parser
        // should not require it — the version field is informational.
        let doc = doc! {
            "_id": "users",
            "schema": {
                "jsonSchema": { "bsonType": "object" },
            },
        };
        let (name, _) = parse_schema_document(doc).expect("version is optional");
        assert_eq!(name, "users");
    }

    /// Collection-mode must accept `version` encoded as Int32 (some
    /// EJSON-relaxed JSON imports into `__sql_schemas` write Int32 instead of
    /// NumberLong). Pre-fix, the `get_i64`-only check silently dropped the
    /// mismatch warning on these encodings; post-fix it routes through
    /// `check_schema_version` and treats Int32 symmetrically with i64.
    #[test]
    fn parse_schema_document_accepts_version_int32() {
        let doc = doc! {
            "_id": "users",
            "schema": {
                "version": 99_i32, // mismatched, encoded as Int32
                "jsonSchema": { "bsonType": "object", "properties": {
                    "email": { "bsonType": "string" },
                }},
            },
        };
        let (name, schema) =
            parse_schema_document(doc).expect("collection-mode i32 version still parses");
        assert_eq!(name, "users");
        assert!(schema.properties.is_some());
    }

    /// Collection-mode must accept `version` encoded as Double — same EJSON
    /// drift path. A clean integer-valued Double must produce no error.
    #[test]
    fn parse_schema_document_accepts_version_double() {
        let doc = doc! {
            "_id": "users",
            "schema": {
                "version": 1.0_f64,
                "jsonSchema": { "bsonType": "object", "properties": {
                    "x": { "bsonType": "string" },
                }},
            },
        };
        let (name, _) =
            parse_schema_document(doc).expect("collection-mode f64 version still parses");
        assert_eq!(name, "users");
    }

    /// Build a full `Catalog` from a vector of `__sql_schemas` documents using
    /// the same path `load_from_collection` does (minus the I/O).
    fn build_catalog_from_docs(db: &str, docs: Vec<Document>) -> Result<Catalog> {
        let mut by_coll: BTreeMap<String, JsonSchema> = BTreeMap::new();
        for d in docs {
            let (name, schema) = parse_schema_document(d)?;
            by_coll.insert(name, schema);
        }
        let mut by_db = BTreeMap::new();
        by_db.insert(db.to_string(), by_coll);
        build_catalog_from_catalog_schema(by_db).map_err(|e| Error::SchemaInvalid {
            msg: format!("catalog build failed: {e}"),
        })
    }

    #[test]
    fn build_catalog_single_collection() {
        let docs = vec![make_doc(
            "users",
            doc! { "email": { "bsonType": "string" } },
        )];
        let catalog = build_catalog_from_docs("mydb", docs).expect("builds");
        let ns = Namespace {
            database: "mydb".to_string(),
            collection: "users".to_string(),
        };
        assert!(catalog.get_schema_for_namespace(&ns).is_some());
    }

    #[test]
    fn build_catalog_multiple_collections_merge() {
        let docs = vec![
            make_doc("users", doc! { "email": { "bsonType": "string" } }),
            make_doc("orders", doc! { "amount": { "bsonType": "decimal" } }),
            make_doc("accounts", doc! { "tier": { "bsonType": "string" } }),
        ];
        let catalog = build_catalog_from_docs("mydb", docs).expect("builds");
        for coll in &["users", "orders", "accounts"] {
            let ns = Namespace {
                database: "mydb".to_string(),
                collection: (*coll).to_string(),
            };
            assert!(
                catalog.get_schema_for_namespace(&ns).is_some(),
                "expected catalog to contain `mydb.{coll}`",
            );
        }
    }

    #[test]
    fn build_catalog_failing_doc_includes_collection_in_error() {
        // One good, one bad — the loader fails on the bad one and the message
        // identifies which collection caused it.
        let docs = vec![
            make_doc("users", doc! { "email": { "bsonType": "string" } }),
            // missing jsonSchema
            doc! { "_id": "broken", "schema": { "version": 1_i64 } },
        ];
        match build_catalog_from_docs("mydb", docs) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("broken"), "expected 'broken' in msg: {msg}");
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // T05 — File-mode loader tests
    // -----------------------------------------------------------------

    fn fixture_path(name: &str) -> std::path::PathBuf {
        // CARGO_MANIFEST_DIR points at crates/native; fixtures live at the
        // repo root under tests/integration/fixtures/.
        let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        crate_dir
            .join("..")
            .join("..")
            .join("tests")
            .join("integration")
            .join("fixtures")
            .join(name)
    }

    fn assert_catalog_has(catalog: &Catalog, db: &str, collections: &[&str]) {
        for coll in collections {
            let ns = Namespace {
                database: db.to_string(),
                collection: (*coll).to_string(),
            };
            assert!(
                catalog.get_schema_for_namespace(&ns).is_some(),
                "expected catalog to contain `{db}.{coll}`",
            );
        }
    }

    #[test]
    fn load_from_file_yaml_happy_path() {
        let path = fixture_path("mongo-schema.yaml");
        let catalog = load_from_file(&path).expect("yaml fixture loads");
        assert_catalog_has(
            &catalog,
            FILE_MODE_DB_PLACEHOLDER,
            &["users", "accounts", "orders"],
        );
    }

    #[test]
    fn load_from_file_json_happy_path() {
        let path = fixture_path("mongo-schema.json");
        let catalog = load_from_file(&path).expect("json fixture loads");
        assert_catalog_has(
            &catalog,
            FILE_MODE_DB_PLACEHOLDER,
            &["users", "accounts", "orders"],
        );
    }

    #[test]
    fn load_from_file_yaml_and_json_produce_equivalent_catalogs() {
        // Same logical content in both formats → byte-identical Catalogs.
        let yaml = load_from_file(&fixture_path("mongo-schema.yaml")).expect("yaml loads");
        let json = load_from_file(&fixture_path("mongo-schema.json")).expect("json loads");

        // Catalog isn't directly comparable; but per-namespace schema lookup
        // *is*, and the two should return Some for the same namespaces and
        // identical Schemas.
        for coll in &["users", "accounts", "orders"] {
            let ns = Namespace {
                database: FILE_MODE_DB_PLACEHOLDER.to_string(),
                collection: (*coll).to_string(),
            };
            let y = yaml.get_schema_for_namespace(&ns);
            let j = json.get_schema_for_namespace(&ns);
            assert!(y.is_some() && j.is_some(), "missing namespace `{coll}`");
            // Schema is internally a recursive structure; Debug equality is a
            // strong check (it includes every nested field).
            assert_eq!(
                format!("{:?}", y.unwrap()),
                format!("{:?}", j.unwrap()),
                "yaml/json schemas diverge for collection `{coll}`",
            );
        }
    }

    /// File-mode must accept `version` encoded as Int32. JSON-imported files
    /// produce Int32 by default (no `NumberLong("…")` wrapper), and our
    /// previous `get_i64`-only check silently skipped the mismatch warning
    /// for these. Post-fix it routes through `check_schema_version` and
    /// treats Int32 symmetrically with i64.
    #[test]
    fn load_from_file_accepts_version_int32() {
        // `version: 99` written as a JSON integer parses as i32 via the
        // serde_json → bson::Bson conversion. The file body must parse
        // cleanly even though 99 ≠ SUPPORTED_SCHEMA_VERSION.
        let tmp = std::env::temp_dir().join("t05_version_i32.json");
        std::fs::write(
            &tmp,
            br#"{"schema":{"version":99,"jsonSchema":{"bsonType":"object","properties":{"users":{"bsonType":"object","properties":{"email":{"bsonType":"string"}}}}}}}"#,
        )
        .expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        let catalog = res.expect("file-mode i32 version still parses");
        let ns = Namespace {
            database: FILE_MODE_DB_PLACEHOLDER.to_string(),
            collection: "users".to_string(),
        };
        assert!(catalog.get_schema_for_namespace(&ns).is_some());
    }

    /// File-mode must accept `version` encoded as Double. YAML doesn't
    /// distinguish int from float for `version: 1.0`, and JSON allows
    /// `"version": 1.0` directly.
    #[test]
    fn load_from_file_accepts_version_double() {
        let tmp = std::env::temp_dir().join("t05_version_f64.json");
        std::fs::write(
            &tmp,
            br#"{"schema":{"version":1.0,"jsonSchema":{"bsonType":"object","properties":{"users":{"bsonType":"object","properties":{"email":{"bsonType":"string"}}}}}}}"#,
        )
        .expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        let catalog = res.expect("file-mode f64 version still parses");
        let ns = Namespace {
            database: FILE_MODE_DB_PLACEHOLDER.to_string(),
            collection: "users".to_string(),
        };
        assert!(catalog.get_schema_for_namespace(&ns).is_some());
    }

    #[test]
    fn load_from_file_missing_file() {
        let path = std::path::PathBuf::from("/nonexistent/schema-missing-12345.yaml");
        match load_from_file(&path) {
            Err(Error::SchemaFileNotFound { path: p }) => {
                assert_eq!(p, path);
            }
            other => panic!("expected SchemaFileNotFound, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_unsupported_extension() {
        // Create a temp file with a bad extension; existence check happens
        // *before* extension check, so the file must exist for the loader
        // to reach the extension validation step.
        let tmp = std::env::temp_dir().join("t05_unsupported_ext.txt");
        std::fs::write(&tmp, b"unused").expect("write tmp");
        let res = load_from_file(&tmp);
        // Best-effort cleanup; ignore unlink errors.
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::ConfigInvalid { field, reason }) => {
                assert_eq!(field, "schema_file");
                assert!(
                    reason.contains("txt"),
                    "reason should mention bad ext: {reason}",
                );
            }
            other => panic!("expected ConfigInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_no_extension() {
        let tmp = std::env::temp_dir().join("t05_no_ext_file");
        std::fs::write(&tmp, b"unused").expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::ConfigInvalid { field, .. }) => {
                assert_eq!(field, "schema_file");
            }
            other => panic!("expected ConfigInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_malformed_yaml() {
        let tmp = std::env::temp_dir().join("t05_malformed.yaml");
        // Tab + colon ambiguity that serde_yaml rejects.
        std::fs::write(&tmp, "schema:\n  version: 1\n  jsonSchema: : :\n").expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(
                    msg.to_ascii_lowercase().contains("yaml"),
                    "msg should mention YAML: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_malformed_json() {
        let tmp = std::env::temp_dir().join("t05_malformed.json");
        std::fs::write(&tmp, b"{ not valid json").expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(
                    msg.to_ascii_lowercase().contains("json"),
                    "msg should mention JSON: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_missing_properties_block() {
        // Valid envelope shell with no `schema.jsonSchema.properties`.
        let tmp = std::env::temp_dir().join("t05_no_props.yaml");
        std::fs::write(
            &tmp,
            "schema:\n  version: 1\n  jsonSchema:\n    bsonType: object\n",
        )
        .expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(
                    msg.contains("properties"),
                    "msg should mention properties: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_empty_properties_yields_schema_not_found() {
        let tmp = std::env::temp_dir().join("t05_empty_props.json");
        std::fs::write(
            &tmp,
            br#"{"schema":{"version":1,"jsonSchema":{"bsonType":"object","properties":{}}}}"#,
        )
        .expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::SchemaNotFound { msg }) => {
                assert!(
                    msg.contains("properties"),
                    "msg should mention properties: {msg}",
                );
            }
            other => panic!("expected SchemaNotFound, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_top_level_not_object() {
        let tmp = std::env::temp_dir().join("t05_top_level_array.json");
        std::fs::write(&tmp, b"[1, 2, 3]").expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(
                    msg.contains("top level"),
                    "msg should mention top level: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_collection_body_not_document_includes_name() {
        let tmp = std::env::temp_dir().join("t05_bad_coll_body.json");
        std::fs::write(
            &tmp,
            br#"{"schema":{"version":1,"jsonSchema":{"bsonType":"object","properties":{"users":"oops"}}}}"#,
        ).expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        match res {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("users"), "msg should name collection: {msg}");
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn load_from_file_yml_extension_alias() {
        // Same content as the YAML fixture, just with .yml extension.
        let yaml_text = std::fs::read_to_string(fixture_path("mongo-schema.yaml")).expect("read");
        let tmp = std::env::temp_dir().join("t05_yml_alias.yml");
        std::fs::write(&tmp, &yaml_text).expect("write tmp");
        let res = load_from_file(&tmp);
        let _ = std::fs::remove_file(&tmp);
        let catalog = res.expect(".yml is a supported extension");
        assert_catalog_has(
            &catalog,
            FILE_MODE_DB_PLACEHOLDER,
            &["users", "accounts", "orders"],
        );
    }

    #[test]
    fn load_from_file_round_trip_matches_collection_mode_logic() {
        // Take the file fixture and compare its catalog (per-namespace
        // schemas) against a catalog built from the equivalent
        // `__sql_schemas` documents via the Collection-mode helper.
        // The two should yield equivalent per-collection JsonSchemas, since
        // they share `parse_collection_schema`.
        let file_catalog = load_from_file(&fixture_path("mongo-schema.yaml")).expect("yaml loads");

        let docs = vec![
            make_doc(
                "users",
                doc! {
                    "_id":        { "bsonType": "objectId" },
                    "email":      { "bsonType": "string" },
                    "name":       { "bsonType": "string" },
                    "account_id": { "bsonType": "string" },
                    "created_at": { "bsonType": "date" },
                },
            ),
            make_doc(
                "accounts",
                doc! {
                    "_id":        { "bsonType": "string" },
                    "name":       { "bsonType": "string" },
                    "tier":       { "bsonType": "string" },
                    "created_at": { "bsonType": "date" },
                },
            ),
            make_doc(
                "orders",
                doc! {
                    "_id":        { "bsonType": "objectId" },
                    "account_id": { "bsonType": "string" },
                    "amount":     { "bsonType": "decimal" },
                    "status":     { "bsonType": "string" },
                    "created_at": { "bsonType": "date" },
                    "updated_at": { "bsonType": "date" },
                },
            ),
        ];
        // Mirror the file-mode db convention (placeholder) so namespaces line up.
        let coll_catalog = build_catalog_from_docs(FILE_MODE_DB_PLACEHOLDER, docs)
            .expect("collection-mode builds");

        for coll in &["users", "accounts", "orders"] {
            let ns = Namespace {
                database: FILE_MODE_DB_PLACEHOLDER.to_string(),
                collection: (*coll).to_string(),
            };
            let f = file_catalog.get_schema_for_namespace(&ns);
            let c = coll_catalog.get_schema_for_namespace(&ns);
            assert!(f.is_some() && c.is_some(), "missing namespace `{coll}`");
            assert_eq!(
                format!("{:?}", f.unwrap()),
                format!("{:?}", c.unwrap()),
                "file-mode and collection-mode schemas diverge for `{coll}`",
            );
        }
    }

    // -----------------------------------------------------------------
    // T06 — Refresh task helpers + tests
    // -----------------------------------------------------------------

    /// Build a tiny non-empty catalog under `db`/`coll`, suitable as a
    /// loader return value. Used by the refresh-task tests to verify cache
    /// content after a swap.
    fn tiny_catalog(db: &str, coll: &str) -> Catalog {
        let docs = vec![make_doc(coll, doc! { "v": { "bsonType": "string" } })];
        build_catalog_from_docs(db, docs).expect("test catalog builds")
    }

    /// Hold a refcount on the loader's `AtomicUsize` callcount so test
    /// assertions can wait deterministically for the loader to fire.
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Count how many namespaces a catalog exposes for a given (db, list of
    /// candidate colls). Used as a coarse "is this the catalog I expected"
    /// fingerprint, since `Catalog` itself is not directly comparable.
    fn catalog_has_ns(cat: &Catalog, db: &str, coll: &str) -> bool {
        let ns = Namespace {
            database: db.to_string(),
            collection: coll.to_string(),
        };
        cat.get_schema_for_namespace(&ns).is_some()
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_task_runs_after_interval() {
        let cache = SchemaCache::new_empty();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_loader = Arc::clone(&calls);

        let handle = spawn_refresh_task(cache.clone(), 30, move || {
            let n = calls_loader.fetch_add(1, Ordering::SeqCst) + 1;
            // First call returns "users", second returns "orders" so we can
            // detect distinct refreshes by inspecting the cache content.
            let coll = if n == 1 { "users" } else { "orders" };
            async move { Ok(tiny_catalog("mydb", coll)) }
        });

        // Yield so the spawned task gets a chance to enter its select loop
        // and register the first sleep timer.
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        // Initial: loader has not fired (it fires *after* the first interval).
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!catalog_has_ns(&cache.read(), "mydb", "users"));

        // Sleep on the test future for one interval — under `start_paused` the
        // current_thread runtime auto-advances paused time when all tasks are
        // idle, which fires the refresh task's sleep without an explicit
        // `advance` race. The extra slack ensures the loader future has time
        // to resolve before we observe.
        tokio::time::sleep(std::time::Duration::from_secs(31)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(catalog_has_ns(&cache.read(), "mydb", "users"));

        // Second tick: loader returns the "orders" catalog and the cache swaps.
        tokio::time::sleep(std::time::Duration::from_secs(31)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(catalog_has_ns(&cache.read(), "mydb", "orders"));

        handle.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_failure_retains_stale_cache() {
        let cache = SchemaCache::new_empty();
        // Pre-populate cache with a known-good catalog so we can detect
        // whether a failed refresh clobbered it.
        cache.write(Arc::new(tiny_catalog("mydb", "users")));

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_loader = Arc::clone(&calls);

        let handle = spawn_refresh_task(cache.clone(), 10, move || {
            let n = calls_loader.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                if n == 1 {
                    // First refresh: simulate a transient load failure.
                    Err(Error::SchemaInvalid {
                        msg: "synthetic failure".to_string(),
                    })
                } else {
                    // Second refresh: succeed with a *different* catalog so
                    // we can prove the retry actually swapped.
                    Ok(tiny_catalog("mydb", "orders"))
                }
            }
        });

        for _ in 0..5 {
            tokio::task::yield_now().await;
        }

        // First tick: failure path. Cache must remain at "users".
        tokio::time::sleep(std::time::Duration::from_secs(11)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(catalog_has_ns(&cache.read(), "mydb", "users"));
        assert!(!catalog_has_ns(&cache.read(), "mydb", "orders"));

        // Second tick: success path. Cache must swap to "orders".
        tokio::time::sleep(std::time::Duration::from_secs(11)).await;
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(catalog_has_ns(&cache.read(), "mydb", "orders"));

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_stops_task_within_bounded_time() {
        // No paused clock here: real Tokio time so the shutdown bound is
        // wall-clock meaningful. Refresh interval is large enough that the
        // task is guaranteed to be parked in `sleep` when we signal.
        let cache = SchemaCache::new_empty();
        let handle = spawn_refresh_task(cache.clone(), 3600, move || async move {
            Ok(tiny_catalog("mydb", "users"))
        });

        // Give the task a moment to enter its select loop.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Shutdown must complete well within a second — the bound exists so
        // a regression to the Weak-self-stop pattern (which can wait up to
        // the full refresh interval) would fail this test.
        let res = tokio::time::timeout(std::time::Duration::from_secs(1), handle.shutdown()).await;
        assert!(res.is_ok(), "shutdown did not return within 1s");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_readers_observe_consistent_swap() {
        // Spawn 100 readers (as OS threads via `spawn_blocking` so they don't
        // monopolize the async runtime) that hammer `cache.read()` while a
        // writer thread alternates between two catalogs. Each reader must
        // observe a *valid* catalog at every read — never a half-swapped
        // state. The `RwLock<Arc<...>>` outer-swap pattern guarantees readers
        // either see the old `Arc` or the new `Arc`, never an in-between.
        let cache = SchemaCache::new_empty();
        cache.write(Arc::new(tiny_catalog("mydb", "users")));

        let stop = Arc::new(AtomicUsize::new(0));
        let mut readers = Vec::with_capacity(100);
        for _ in 0..100 {
            let cache = cache.clone();
            let stop = Arc::clone(&stop);
            readers.push(std::thread::spawn(move || {
                let mut observed_users = 0usize;
                let mut observed_orders = 0usize;
                while stop.load(Ordering::SeqCst) == 0 {
                    let cat = cache.read();
                    let has_users = catalog_has_ns(&cat, "mydb", "users");
                    let has_orders = catalog_has_ns(&cat, "mydb", "orders");
                    // The catalog is always *one of* the two states we wrote;
                    // never both (different collection names) and never
                    // neither (we pre-seeded the cache).
                    assert!(
                        has_users ^ has_orders,
                        "inconsistent catalog observed: users={has_users} orders={has_orders}",
                    );
                    if has_users {
                        observed_users += 1;
                    }
                    if has_orders {
                        observed_orders += 1;
                    }
                }
                (observed_users, observed_orders)
            }));
        }

        // Force many swaps from a separate writer thread so reads and writes
        // genuinely race on the lock.
        let writer_cache = cache.clone();
        let writer_stop = Arc::clone(&stop);
        let writer = std::thread::spawn(move || {
            let mut i = 0u64;
            while writer_stop.load(Ordering::SeqCst) == 0 {
                let coll = if i.is_multiple_of(2) {
                    "users"
                } else {
                    "orders"
                };
                writer_cache.write(Arc::new(tiny_catalog("mydb", coll)));
                i = i.wrapping_add(1);
            }
            i
        });

        // Let the storm run briefly; bounded so the test stays fast in CI.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        stop.store(1, Ordering::SeqCst);

        let mut total_users = 0usize;
        let mut total_orders = 0usize;
        for r in readers {
            let (u, o) = r.join().expect("reader did not panic");
            total_users += u;
            total_orders += o;
        }
        let writes = writer.join().expect("writer did not panic");

        // Sanity: the storm actually did something on both sides. Without a
        // real swap the inconsistency assertion would be meaningless.
        assert!(writes > 0, "writer made no swaps");
        assert!(total_users + total_orders > 0, "readers observed nothing",);
    }

    #[test]
    fn many_swaps_do_not_leak() {
        // Best-effort no-leak signal: perform 1000 swaps and assert the
        // SchemaCache's outer `Arc<RwLock<Arc<Catalog>>>` retains its
        // type-level size and that strong-count on the *outer* Arc held by
        // the cache stays bounded. We can't measure heap precisely without
        // an allocator hook, but a leak in the swap path would manifest as
        // unbounded growth in observable references.
        let cache = SchemaCache::new_empty();
        let outer_size_before = std::mem::size_of_val(&cache);

        for i in 0..1000_u32 {
            // Alternate between two catalogs so each iteration triggers a
            // real swap (rather than identical-pointer noop).
            let coll = if i.is_multiple_of(2) {
                "users"
            } else {
                "orders"
            };
            cache.write(Arc::new(tiny_catalog("mydb", coll)));
        }

        let outer_size_after = std::mem::size_of_val(&cache);
        assert_eq!(outer_size_before, outer_size_after);

        // The cache holds exactly one inner `Arc<Catalog>`; after 1000 swaps,
        // any leaked references would be visible as elevated strong-count on
        // the *current* inner Arc. The current inner Arc is freshly written,
        // so its strong count must be 1 once we drop our local handle.
        let current = cache.read();
        // `current` and the cache's stored Arc both reference the same
        // allocation: strong count must be exactly 2.
        assert_eq!(Arc::strong_count(&current), 2);
        drop(current);
        // After dropping our reader handle, only the cache holds it.
        let again = cache.read();
        assert_eq!(Arc::strong_count(&again), 2);
    }

    #[test]
    fn schema_cache_default_empty_and_swap() {
        let cache = SchemaCache::new_empty();
        let initial = cache.read();
        // default catalog has no namespaces; querying yields None.
        let ns = Namespace {
            database: "x".to_string(),
            collection: "y".to_string(),
        };
        assert!(initial.get_schema_for_namespace(&ns).is_none());

        // Build a non-empty catalog and swap it in.
        let docs = vec![make_doc(
            "users",
            doc! { "email": { "bsonType": "string" } },
        )];
        let new_catalog = build_catalog_from_docs("mydb", docs).expect("builds non-empty catalog");
        cache.write(Arc::new(new_catalog));

        let after = cache.read();
        let ns = Namespace {
            database: "mydb".to_string(),
            collection: "users".to_string(),
        };
        assert!(after.get_schema_for_namespace(&ns).is_some());

        // The old Arc held by `initial` is unaffected by the swap.
        let old_ns = Namespace {
            database: "mydb".to_string(),
            collection: "users".to_string(),
        };
        assert!(initial.get_schema_for_namespace(&old_ns).is_none());
    }

    // -----------------------------------------------------------------
    // Atlas SQL — sqlGetSchema response parsing + system-collection filter
    // -----------------------------------------------------------------

    /// Build a well-formed `sqlGetSchema` response with a populated schema.
    fn atlas_sql_response_with_schema(properties: Document) -> Document {
        doc! {
            "ok": 1.0,
            "metadata": { "description": "set using sqlSetSchema" },
            "schema": {
                "version": 1_i64,
                "jsonSchema": {
                    "bsonType": "object",
                    "properties": properties,
                },
            },
        }
    }

    /// Canonical "no schema set" response shape per the Atlas SQL docs.
    fn atlas_sql_empty_response() -> Document {
        doc! {
            "ok": 1.0,
            "metadata": {},
            "schema": {},
        }
    }

    #[test]
    fn parse_atlas_sql_response_with_schema_yields_parsed_pair() {
        let response = atlas_sql_response_with_schema(doc! {
            "_id":   { "bsonType": "objectId" },
            "email": { "bsonType": "string" },
        });
        let parsed =
            parse_atlas_sql_response("calllogs", response).expect("populated schema parses");
        let (name, schema) = parsed.expect("populated response is Some");
        assert_eq!(name, "calllogs");
        let props = schema.properties.expect("properties present");
        assert!(props.contains_key("email"));
        assert!(props.contains_key("_id"));
    }

    #[test]
    fn parse_atlas_sql_response_empty_schema_is_none_not_error() {
        // Per the canonical Atlas SQL docs, `{ok: 1, metadata: {}, schema: {}}`
        // means "no schema set for this name" — the collection MUST be
        // skipped, never errored.
        let response = atlas_sql_empty_response();
        let parsed = parse_atlas_sql_response("system.views", response)
            .expect("empty response parses cleanly");
        assert!(
            parsed.is_none(),
            "empty schema response must yield None (skip)",
        );
    }

    #[test]
    fn parse_atlas_sql_response_missing_schema_is_none() {
        // Defensive: a response that elides `schema` entirely is treated the
        // same as an empty schema (skip).
        let response = doc! { "ok": 1.0, "metadata": {} };
        let parsed = parse_atlas_sql_response("x", response).expect("parses");
        assert!(parsed.is_none());
    }

    #[test]
    fn parse_atlas_sql_response_null_schema_is_none() {
        let response = doc! { "ok": 1.0, "schema": bson::Bson::Null };
        let parsed = parse_atlas_sql_response("x", response).expect("parses");
        assert!(parsed.is_none());
    }

    #[test]
    fn parse_atlas_sql_response_ok_zero_yields_schema_invalid() {
        // Defence-in-depth: explicit `ok: 0` (server-side failure) maps to
        // SchemaInvalid with a hint about atlas-sql mode requirements. In
        // practice the mongodb crate raises this before we reach the parser,
        // but the doc-driven contract is to fail closed if a future server
        // version slips through.
        let response = doc! {
            "ok": 0.0,
            "errmsg": "no such command: 'sqlGetSchema'",
        };
        match parse_atlas_sql_response("calllogs", response) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(
                    msg.contains("calllogs"),
                    "msg should mention collection: {msg}",
                );
                assert!(
                    msg.contains("atlas-sql"),
                    "msg should hint at atlas-sql mode requirement: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_atlas_sql_response_non_document_schema_yields_schema_invalid() {
        let response = doc! { "ok": 1.0, "schema": "not a document" };
        match parse_atlas_sql_response("x", response) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("schema"));
                assert!(msg.contains("document"));
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_atlas_sql_response_missing_jsonschema_yields_schema_invalid() {
        // Populated `schema` but no `jsonSchema` inside — malformed envelope.
        let response = doc! {
            "ok": 1.0,
            "schema": { "version": 1_i64 },
        };
        match parse_atlas_sql_response("x", response) {
            Err(Error::SchemaInvalid { msg }) => {
                assert!(msg.contains("jsonSchema"));
                assert!(msg.contains('x'));
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn parse_atlas_sql_response_accepts_version_long() {
        // The Atlas SQL endpoint returns `version` as a NumberLong (i64). The
        // parser must accept that natively without complaint.
        let response = doc! {
            "ok": 1.0,
            "schema": {
                "version": 1_i64,
                "jsonSchema": { "bsonType": "object", "properties": {
                    "email": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("users", response).expect("parses");
        assert!(parsed.is_some());
    }

    #[test]
    fn parse_atlas_sql_response_accepts_ok_as_i32() {
        // Some BSON serialisers encode the boolean `ok` as int32. Mongo's own
        // server returns f64 in practice but defence-in-depth covers both.
        let response = doc! {
            "ok": 1_i32,
            "schema": {
                "version": 1_i64,
                "jsonSchema": { "bsonType": "object", "properties": {
                    "x": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("c", response).expect("parses");
        assert!(parsed.is_some());
    }

    #[test]
    fn parse_atlas_sql_response_permissive_on_version_mismatch() {
        // Version mismatch is informational — parse continues with a warning.
        let response = doc! {
            "ok": 1.0,
            "schema": {
                "version": 99_i64,
                "jsonSchema": { "bsonType": "object", "properties": {
                    "email": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("users", response).expect("permissive");
        let (name, schema) = parsed.expect("populated");
        assert_eq!(name, "users");
        assert!(schema.properties.is_some());
    }

    #[test]
    fn is_system_or_internal_collection_matches_expected_names() {
        assert!(is_system_or_internal_collection("system.views"));
        assert!(is_system_or_internal_collection("system.profile"));
        assert!(is_system_or_internal_collection("system.indexes"));
        assert!(is_system_or_internal_collection("__sql_schemas"));
        // Not system / not internal:
        assert!(!is_system_or_internal_collection("calllogs"));
        assert!(!is_system_or_internal_collection("users"));
        // Leading underscore on a user collection: not filtered (Atlas SQL
        // does not reserve the `_*` prefix; only `__sql_schemas` is special).
        assert!(!is_system_or_internal_collection("_users"));
        assert!(!is_system_or_internal_collection("__custom"));
        // `systemic` / `systems` are NOT system.* — only the exact prefix
        // `system.` (with the dot) is reserved.
        assert!(!is_system_or_internal_collection("systemic"));
        assert!(!is_system_or_internal_collection("systems"));
    }

    /// Drive the full atlas-sql pipeline at the parse layer: given a vector
    /// of `(name, response)` pairs (mirroring what `collect_atlas_sql_docs`
    /// would feed in), assert the resulting `BTreeMap<coll, Schema>` matches
    /// expectations. This is the strongest pure-function unit test we can
    /// build without a mongo client.
    fn collect_via_parser(
        responses: Vec<(&str, Document)>,
    ) -> Result<BTreeMap<String, JsonSchema>> {
        let mut by_collection: BTreeMap<String, JsonSchema> = BTreeMap::new();
        for (name, response) in responses {
            if is_system_or_internal_collection(name) {
                continue;
            }
            if let Some((coll, schema)) = parse_atlas_sql_response(name, response)? {
                by_collection.insert(coll, schema);
            }
        }
        Ok(by_collection)
    }

    #[test]
    fn atlas_sql_pipeline_filters_systems_and_skips_empty_schemas() {
        // Mixed inputs: populated, empty, and system collections all in one
        // pass. Only the populated user collections must appear in the map.
        let responses = vec![
            (
                "calllogs",
                atlas_sql_response_with_schema(doc! { "ts": { "bsonType": "date" } }),
            ),
            (
                "configversions",
                atlas_sql_response_with_schema(doc! { "v": { "bsonType": "int" } }),
            ),
            // Empty schema — skip.
            ("system.views", atlas_sql_empty_response()),
            // Populated but filtered out by system. prefix even though Atlas
            // SQL would return empty for it.
            (
                "system.profile",
                atlas_sql_response_with_schema(doc! { "x": { "bsonType": "string" } }),
            ),
            // __sql_schemas — defence-in-depth filter.
            (
                "__sql_schemas",
                atlas_sql_response_with_schema(doc! { "_id": { "bsonType": "string" } }),
            ),
            // Another user collection with no schema configured.
            ("orphans", atlas_sql_empty_response()),
        ];
        let by_coll = collect_via_parser(responses).expect("pipeline succeeds");
        let names: Vec<&str> = by_coll.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            vec!["calllogs", "configversions"],
            "only user collections with populated schemas survive",
        );
    }

    #[test]
    fn atlas_sql_pipeline_builds_catalog_with_multiple_collections() {
        // End-to-end-from-parser: feed a few populated responses into the
        // same pipeline `load_from_atlas_sql_with_columns` uses and assert
        // the resulting catalog exposes every namespace.
        let responses = vec![
            (
                "users",
                atlas_sql_response_with_schema(doc! { "email": { "bsonType": "string" } }),
            ),
            (
                "orders",
                atlas_sql_response_with_schema(doc! { "amount": { "bsonType": "decimal" } }),
            ),
            (
                "accounts",
                atlas_sql_response_with_schema(doc! { "tier": { "bsonType": "string" } }),
            ),
        ];
        let by_coll = collect_via_parser(responses).expect("pipeline");
        let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
        by_db.insert("mydb".to_string(), by_coll);
        let loaded = build_loaded_schema(by_db).expect("build catalog");
        for coll in &["users", "orders", "accounts"] {
            let ns = Namespace {
                database: "mydb".to_string(),
                collection: (*coll).to_string(),
            };
            assert!(
                loaded.catalog.get_schema_for_namespace(&ns).is_some(),
                "catalog must contain `mydb.{coll}`",
            );
            assert!(
                loaded
                    .columns
                    .contains_key(&("mydb".to_string(), (*coll).to_string())),
                "TableColumns must contain `(mydb, {coll})`",
            );
        }
    }

    #[test]
    fn atlas_sql_pipeline_empty_input_yields_empty_catalog() {
        // listCollections returning an empty list is NOT an error — the
        // catalog is just empty until a future refresh picks up new
        // collections.
        let by_coll = collect_via_parser(vec![]).expect("empty pipeline");
        assert!(by_coll.is_empty());
        let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
        by_db.insert("mydb".to_string(), by_coll);
        let loaded = build_loaded_schema(by_db).expect("build catalog");
        assert!(loaded.columns.is_empty(), "no columns from empty input");
    }

    // -----------------------------------------------------------------
    // Finding #1 — bounded-parallel fan-out
    // -----------------------------------------------------------------

    /// `bounded_fan_out` must actually run futures concurrently up to the
    /// configured limit. The check uses a shared atomic counter to record the
    /// peak in-flight count across all participating futures; with a serial
    /// loop the peak would be exactly 1, with `buffered(N)` it must be > 1
    /// (and ≤ N).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn bounded_fan_out_runs_in_parallel_up_to_limit() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        // 16 jobs through a `buffered(8)` stream. Each job sleeps long enough
        // that the buffered scheduler will hold 8 of them open at once.
        let n_jobs = 16usize;
        let limit = 8usize;
        let mut futs = Vec::with_capacity(n_jobs);
        for _ in 0..n_jobs {
            let in_flight = Arc::clone(&in_flight);
            let peak = Arc::clone(&peak);
            futs.push(async move {
                // bump in-flight, record peak, sleep, then decrement
                let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                // monotonically increase peak to the highest cur seen
                peak.fetch_max(cur, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Ok::<usize, ()>(cur)
            });
        }

        let outs = bounded_fan_out(futs, limit).await.expect("all Ok");
        assert_eq!(outs.len(), n_jobs);
        let observed_peak = peak.load(Ordering::SeqCst);
        assert!(
            observed_peak > 1,
            "expected >1 future in flight (peak={observed_peak}); fan-out is serial",
        );
        assert!(
            observed_peak <= limit,
            "expected peak ≤ {limit} (peak={observed_peak}); fan-out exceeded the cap",
        );
        // Tighter assertion: under a multi-thread runtime with a healthy
        // scheduler the peak should *reach* the cap (i.e. 8 in flight). Use
        // `>= 2` as the floor in case CI runs are starved, but the typical
        // case is exactly `limit`.
        assert!(
            observed_peak >= 2,
            "expected peak ≥ 2 with `buffered({limit})`; got {observed_peak}",
        );
    }

    /// Concurrency clamped to 0 must NOT deadlock; we coerce it to 1 (serial).
    #[tokio::test]
    async fn bounded_fan_out_zero_concurrency_falls_back_to_serial() {
        let futs = (0..4u32).map(|i| async move { Ok::<u32, ()>(i) });
        let outs = bounded_fan_out(futs, 0).await.expect("all Ok");
        assert_eq!(outs, vec![0, 1, 2, 3]);
    }

    /// Output preserves input order so caller log messages line up with input
    /// names — important because the surrounding loop pairs the original
    /// collection name with the parse result for the "empty schema; skipped"
    /// debug log.
    #[tokio::test]
    async fn bounded_fan_out_preserves_input_order() {
        // Each future sleeps for a different amount so the *completion* order
        // (d, c, b, a — shortest sleep first) differs from input order
        // (a, b, c, d). A serial loop would also preserve order, but our
        // assertion catches the failure mode where buffered ordering would
        // surface completion order instead.
        let delays_and_labels = [(80u64, "a"), (40, "b"), (20, "c"), (10, "d")];
        let futs = delays_and_labels
            .into_iter()
            .map(|(delay, label)| async move {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                Ok::<&'static str, ()>(label)
            });
        let outs = bounded_fan_out(futs, 4).await.expect("all Ok");
        assert_eq!(outs, vec!["a", "b", "c", "d"]);
    }

    /// Short-circuit semantics: once any future yields `Err`, no new input
    /// futures are pulled from the iterator. Submits 100 futures where the
    /// 2nd returns an `Err` with a 0ms delay; assert futures #10..#99 never
    /// execute by observing an `AtomicUsize` increment counter inside each
    /// future. The counter must stay ≤ `concurrency + 1` after the helper
    /// returns — the first few futures may have been pulled into the
    /// in-flight window before the error propagated, but the tail is never
    /// pulled.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn bounded_fan_out_short_circuits_on_first_error() {
        let counter = Arc::new(AtomicUsize::new(0));
        let n_jobs = 100usize;
        let concurrency = 8usize;
        let err_idx = 1usize; // 2nd future fails fast

        let futs = (0..n_jobs).map(|i| {
            let counter = Arc::clone(&counter);
            async move {
                // Bump the start counter before yielding so we capture every
                // future that was actually polled into a running state.
                counter.fetch_add(1, Ordering::SeqCst);
                if i == err_idx {
                    // 0ms delay — the error surfaces as fast as the scheduler
                    // can re-poll the result stream.
                    return Err::<usize, &'static str>("forced");
                }
                // Slow down all other futures so the short-circuit clearly
                // beats them to completion: the tail futures (i ≥ 10) MUST
                // not be polled.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                Ok(i)
            }
        });

        let outcome = bounded_fan_out(futs, concurrency).await;
        assert!(outcome.is_err(), "expected Err from forced failure");
        assert_eq!(outcome.unwrap_err(), "forced");

        // The first `concurrency` futures will have been pulled into the
        // in-flight window before the error propagated; under `try_buffered`
        // no NEW futures past that initial window are pulled from the input
        // iterator after the error. The upper bound is `concurrency + 1`
        // (the window plus one extra that the stream adapter may pre-pull
        // depending on scheduler timing). Crucially the bound is independent
        // of `n_jobs` — that's the property the original loop preserved with
        // `?` and the previous variant of this helper had lost.
        let observed = counter.load(Ordering::SeqCst);
        assert!(
            observed <= concurrency + 1,
            "expected ≤ {} futures to be polled (saw {observed}); short-circuit broken",
            concurrency + 1,
        );
        assert!(
            observed < n_jobs,
            "expected < {n_jobs} futures to be polled (saw {observed}); short-circuit did nothing",
        );
    }

    // -----------------------------------------------------------------
    // Finding #2 — error-code branching (Unauthorized vs CommandNotFound)
    // -----------------------------------------------------------------

    #[test]
    fn run_command_error_code_13_yields_unauthorized_hint() {
        // CommandError code 13 = Unauthorized → emit the role-requirements
        // hint with the canonical docs URL. The server-side `errmsg` is NOT
        // included in the user-facing message (it can carry identifiers).
        let e = build_run_command_error_message(
            "dev-convo-hub",
            "calllogs",
            RunCommandErrorClass::CommandCode(MONGO_ERROR_CODE_UNAUTHORIZED),
            "Error code 13 (Unauthorized): not authorized on db",
        );
        match e {
            Error::SchemaInvalid { msg } => {
                assert!(msg.contains("dev-convo-hub.calllogs"));
                assert!(msg.contains("code 13"));
                assert!(msg.contains("Unauthorized"));
                assert!(msg.contains("atlasAdmin"));
                assert!(msg.contains("clusterMonitor"));
                assert!(msg.contains("readAnyDatabase"));
                // Self-contained role description is the load-bearing piece —
                // the operator can act on the message without traversing to
                // docs at all.
                assert!(
                    msg.contains("Atlas UI"),
                    "msg should describe where to make the fix: {msg}",
                );
                assert!(
                    msg.contains(ATLAS_SQL_ROLES_DOC_URL),
                    "msg should cite docs URL: {msg}",
                );
                assert!(
                    !ATLAS_SQL_ROLES_DOC_URL.is_empty(),
                    "ATLAS_SQL_ROLES_DOC_URL must not be empty",
                );
                // The wrong-endpoint hint must NOT appear on the Unauthorized
                // branch — that would be the misleading message we're fixing.
                assert!(
                    !msg.contains("CommandNotFound"),
                    "Unauthorized hint must not mention CommandNotFound: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    /// The new doc URL must point at the Atlas operator-facing user/role
    /// configuration page — NOT the "Atlas SQL Getting Started" page, which
    /// previously misled operators because it does not list role grants.
    #[test]
    fn atlas_sql_roles_doc_url_is_actionable() {
        // The Atlas SQL Getting-Started page does NOT cover role grants and
        // must not be cited as the source of the role-requirements hint.
        assert!(
            !ATLAS_SQL_ROLES_DOC_URL.contains("data-federation/query/sql/getting-started"),
            "must not cite the Atlas SQL Getting-Started page (does not document roles): {ATLAS_SQL_ROLES_DOC_URL}",
        );
        // The chosen URL is the Atlas Configure Database Users page — the
        // operator-facing page where roles are actually edited.
        assert!(
            ATLAS_SQL_ROLES_DOC_URL.contains("security-add-mongodb-users"),
            "expected `security-add-mongodb-users` Atlas docs URL, got: {ATLAS_SQL_ROLES_DOC_URL}",
        );
    }

    #[test]
    fn run_command_error_code_59_yields_command_not_found_hint() {
        // CommandError code 59 = CommandNotFound → emit the "wrong endpoint"
        // hint. The Atlas SQL host pattern must appear so operators can
        // self-diagnose without digging into the docs.
        let e = build_run_command_error_message(
            "dev-convo-hub",
            "users",
            RunCommandErrorClass::CommandCode(MONGO_ERROR_CODE_COMMAND_NOT_FOUND),
            "Error code 59 (CommandNotFound): no such command: 'sqlGetSchema'",
        );
        match e {
            Error::SchemaInvalid { msg } => {
                assert!(msg.contains("dev-convo-hub.users"));
                assert!(msg.contains("code 59"));
                assert!(msg.contains("CommandNotFound"));
                assert!(msg.contains("*.a.query.mongodb.net"));
                // The role-grants hint must NOT appear on the CommandNotFound
                // branch — it would mislead the operator into editing IAM.
                assert!(
                    !msg.contains("atlasAdmin"),
                    "CommandNotFound hint must not suggest role grants: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn run_command_error_other_code_yields_generic_hint() {
        // A CommandError with a code that isn't 13 or 59 falls through to the
        // generic "endpoint may not support sqlGetSchema" hint, with the
        // inner Display string redacted.
        let e = build_run_command_error_message(
            "dev-convo-hub",
            "x",
            RunCommandErrorClass::CommandCode(11_000), // DuplicateKey, just for variety
            "Error code 11000 (DuplicateKey): something",
        );
        match e {
            Error::SchemaInvalid { msg } => {
                assert!(msg.contains("dev-convo-hub.x"));
                assert!(msg.contains("DuplicateKey"));
                assert!(msg.contains("atlas-sql mode requires"));
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    #[test]
    fn run_command_error_non_command_kind_redacts_inner() {
        // Defence-in-depth: simulate a future mongodb-crate variant whose
        // Display embeds a URI string. The redactor must strip the creds
        // before they reach the public error message.
        let e = build_run_command_error_message(
            "dev-convo-hub",
            "calllogs",
            RunCommandErrorClass::Other,
            "I/O error talking to mongodb://alice:s3cret@host:27017/db",
        );
        match e {
            Error::SchemaInvalid { msg } => {
                assert!(
                    !msg.contains("alice"),
                    "must redact username from inner: {msg}",
                );
                assert!(
                    !msg.contains("s3cret"),
                    "must redact password from inner: {msg}",
                );
                assert!(
                    msg.contains("[REDACTED]"),
                    "redaction marker must appear: {msg}",
                );
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // Finding #3 — permissive version parsing
    // -----------------------------------------------------------------

    /// Atlas SQL ships `version` as a NumberLong (i64) in production today,
    /// but our parser must accept Int32 too for byte-format drift.
    #[test]
    fn parse_atlas_sql_response_accepts_version_int32() {
        // The version field is encoded as i32 (mismatched value) → parse
        // should still succeed (permissive) and the warn-level mismatch
        // log should fire (we don't capture it here, but a serial run
        // through `cargo test -- --nocapture` makes it visible).
        let response = doc! {
            "ok": 1.0,
            "schema": {
                "version": 99_i32, // mismatched, encoded as Int32
                "jsonSchema": { "bsonType": "object", "properties": {
                    "email": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("users", response).expect("i32 version still parses");
        let (name, schema) = parsed.expect("populated");
        assert_eq!(name, "users");
        assert!(schema.properties.is_some());
    }

    /// `version` encoded as a Double (e.g. EJSON-relaxed JSON pipelines) with
    /// an integer-valued fractional component must parse cleanly.
    #[test]
    fn parse_atlas_sql_response_accepts_version_double() {
        let response = doc! {
            "ok": 1.0,
            "schema": {
                "version": 1.0_f64,
                "jsonSchema": { "bsonType": "object", "properties": {
                    "x": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("c", response).expect("f64 version parses");
        assert!(parsed.is_some(), "populated body produces Some");
    }

    /// `version` encoded as a non-integer Double is treated as "unrecognised"
    /// — the parser does not silently truncate to an integer. The body still
    /// parses; the version check just doesn't emit a warn-level mismatch.
    #[test]
    fn parse_atlas_sql_response_non_integer_double_version_still_parses() {
        let response = doc! {
            "ok": 1.0,
            "schema": {
                "version": 1.5_f64, // not a clean integer
                "jsonSchema": { "bsonType": "object", "properties": {
                    "x": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("c", response).expect("permissive on bad numerics");
        assert!(parsed.is_some());
    }

    /// A `version` of an entirely unrecognised BSON type (string here, but
    /// could be Decimal128/Null/etc.) must NOT cause the parser to error and
    /// the body must still parse. Observability falls back to `debug!`.
    #[test]
    fn parse_atlas_sql_response_string_version_still_parses() {
        let response = doc! {
            "ok": 1.0,
            "schema": {
                "version": "v1",
                "jsonSchema": { "bsonType": "object", "properties": {
                    "x": { "bsonType": "string" },
                }},
            },
        };
        let parsed = parse_atlas_sql_response("c", response).expect("permissive on string version");
        assert!(parsed.is_some());
    }

    /// Direct drive of `check_schema_version`. Coverage: i64, i32, f64-int,
    /// f64-fractional, string. The function returns no value — we exercise
    /// it to ensure none of the paths panic and the cargo build remains warn-clean.
    #[test]
    fn check_schema_version_handles_all_numeric_encodings() {
        check_schema_version(&doc! { "version": 1_i64 }, "x");
        check_schema_version(&doc! { "version": 99_i64 }, "x"); // mismatch warn path
        check_schema_version(&doc! { "version": 1_i32 }, "x");
        check_schema_version(&doc! { "version": 99_i32 }, "x"); // mismatch warn path
        check_schema_version(&doc! { "version": 1.0_f64 }, "x");
        check_schema_version(&doc! { "version": 1.5_f64 }, "x"); // unparseable
        check_schema_version(&doc! { "version": "v1" }, "x"); // unparseable
        check_schema_version(&doc! {}, "x"); // missing
    }

    // -----------------------------------------------------------------
    // Finding #4 — central URI-redaction routing
    // -----------------------------------------------------------------

    /// The listCollections error-message builder must route the inner
    /// upstream Display string through `redact_uri_creds` before it lands in
    /// the public `Error::SchemaInvalid { msg }`.
    #[test]
    fn list_collections_error_message_redacts_uri_creds() {
        let e = build_list_collections_error_message(
            "dev-convo-hub",
            false,
            "I/O error connecting to mongodb://alice:s3cret@host:27017/db",
        );
        match e {
            Error::SchemaInvalid { msg } => {
                assert!(
                    !msg.contains("alice"),
                    "must redact username from inner: {msg}",
                );
                assert!(
                    !msg.contains("s3cret"),
                    "must redact password from inner: {msg}",
                );
                assert!(
                    msg.contains("[REDACTED]"),
                    "redaction marker must appear: {msg}",
                );
                assert!(msg.contains("dev-convo-hub"), "db name must survive: {msg}",);
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    /// Authentication branch on listCollections must NOT pull in any inner
    /// message — that's the original cred-leak risk it was built to dodge.
    #[test]
    fn list_collections_error_authentication_message_is_constant() {
        let e = build_list_collections_error_message(
            "dev-convo-hub",
            true,
            "anything goes here including mongodb://alice:s3cret@host",
        );
        match e {
            Error::AuthFailed { msg } => {
                assert!(!msg.contains("alice"));
                assert!(!msg.contains("s3cret"));
                assert!(!msg.contains("mongodb://"));
                assert_eq!(msg, "authentication handshake rejected by server");
            }
            other => panic!("expected AuthFailed, got {other:?}"),
        }
    }

    /// Defence-in-depth: even a non-13/non-59 command code routes its inner
    /// Display string through the redactor.
    #[test]
    fn run_command_error_command_code_other_redacts_inner() {
        let e = build_run_command_error_message(
            "dev-convo-hub",
            "calllogs",
            RunCommandErrorClass::CommandCode(99_999),
            "Command failed talking to mongodb://alice:s3cret@host:27017/db",
        );
        match e {
            Error::SchemaInvalid { msg } => {
                assert!(!msg.contains("alice"));
                assert!(!msg.contains("s3cret"));
                assert!(msg.contains("[REDACTED]"));
            }
            other => panic!("expected SchemaInvalid, got {other:?}"),
        }
    }

    /// `BsonTypeName::Long` (BSON NumberLong / Int64) maps to SQL `"bigint"`,
    /// preserving the full i64 range. Mapping to `"int"` would silently
    /// truncate values past `i32::MAX` downstream in Cube Store's column-type
    /// tracker. Matches the query-result column-type derivation in
    /// `execute::cube_type_for_schema` (which also emits `"bigint"`).
    #[test]
    fn bson_long_maps_to_bigint_not_int() {
        let docs = vec![make_doc(
            "events",
            doc! {
                // i64 well above i32::MAX — `Long` is the BSON type for these.
                "row_count": { "bsonType": "long" },
                "compare_int": { "bsonType": "int" },
            },
        )];
        let loaded = {
            let mut by_db: BTreeMap<String, BTreeMap<String, JsonSchema>> = BTreeMap::new();
            for d in docs {
                let coll = d.get_str("_id").unwrap().to_string();
                let raw = d.get_document("schema").unwrap().get_document("jsonSchema").unwrap();
                let schema: JsonSchema = bson::from_document(raw.clone()).unwrap();
                by_db
                    .entry("mydb".to_string())
                    .or_default()
                    .insert(coll, schema);
            }
            build_loaded_schema(by_db).expect("builds")
        };
        let cols = loaded
            .columns
            .get(&("mydb".to_string(), "events".to_string()))
            .expect("events collection columns");
        let long_col = cols.iter().find(|c| c.name == "row_count").expect("row_count col");
        let int_col = cols.iter().find(|c| c.name == "compare_int").expect("compare_int col");
        assert_eq!(
            long_col.sql_type, "bigint",
            "BsonTypeName::Long must map to bigint, got {}",
            long_col.sql_type,
        );
        assert_eq!(
            int_col.sql_type, "int",
            "BsonTypeName::Int still maps to int (regression guard); got {}",
            int_col.sql_type,
        );
    }
}

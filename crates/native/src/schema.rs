//! Schema loader and cache. See ARCHITECTURE.md §3 and SPEC.md §5.3.
//!
//! T04 implements Collection-mode loading. T05 adds File-mode loading. T06
//! will wire the refresh task. The cache type lives here so T06 can land
//! additively without a redesign.
//!
//! ## Collection-mode envelope
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
//! ## File-mode envelope
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
//! ## Trust boundary
//!
//! `load_from_file` uses the caller-supplied path as-is. No path-traversal
//! mitigation is performed by the loader; it is the caller's responsibility
//! to validate the path against any policy (e.g. confining to a designated
//! schema directory). The file is opened with the process's privileges.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use bson::{doc, Document};
use futures_util::TryStreamExt;
use mongosql::{
    build_catalog_from_catalog_schema,
    catalog::Catalog,
    json_schema::{self, Schema as JsonSchema},
};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::error::{Error, Result};

/// Re-export of the upstream catalog so other modules don't import `mongosql`
/// directly. T07 (translate wrapper) consumes this.
pub type MongoSqlCatalog = Catalog;

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

    // version is informational; missing/wrong versions are accepted but logged.
    if let Ok(v) = schema_doc.get_i64("version") {
        if v != SUPPORTED_SCHEMA_VERSION {
            tracing::warn!(
                target: "mongosql_driver::schema",
                collection = collection_name.as_str(),
                version = v,
                expected = SUPPORTED_SCHEMA_VERSION,
                "schema version mismatch; attempting to parse jsonSchema anyway",
            );
        }
    }

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

    // Permissive version handling — same convention as Collection-mode.
    if let Ok(v) = schema_block.get_i64("version") {
        if v != SUPPORTED_SCHEMA_VERSION {
            tracing::warn!(
                target: "mongosql_driver::schema",
                file = %path.display(),
                version = v,
                expected = SUPPORTED_SCHEMA_VERSION,
                "schema file version mismatch; attempting to parse jsonSchema anyway",
            );
        }
    }

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
    pub async fn shutdown(self) {
        self.shutdown.notify_waiters();
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
}

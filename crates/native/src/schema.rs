//! Schema loader and cache. See ARCHITECTURE.md §3 and SPEC.md §5.3.
//!
//! T04 implements Collection-mode loading. T05 will add File-mode loading and
//! T06 will wire the refresh task. The cache type lives here so T05/T06 can
//! land additively without a redesign.
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

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use bson::{doc, Document};
use futures_util::TryStreamExt;
use mongosql::{
    build_catalog_from_catalog_schema,
    catalog::Catalog,
    json_schema::{self, Schema as JsonSchema},
};

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

    let json_schema =
        json_schema::Schema::from_document(json_schema_doc).map_err(|e| Error::SchemaInvalid {
            msg: format!("collection `{collection_name}`: jsonSchema parse failed: {e}"),
        })?;

    Ok((collection_name, json_schema))
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

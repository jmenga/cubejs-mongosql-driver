//! mongosql translation wrapper. See ARCHITECTURE.md §4.1.
//!
//! Implementation arrives in T07.

use crate::error::{Error, Result};
use crate::schema::MongoSqlCatalog;

/// Result of translating a SQL query.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Translation {
    /// Target database name.
    pub target_db: String,
    /// Target collection name (where the aggregate runs).
    pub target_collection: String,
    /// MQL aggregation pipeline as BSON documents.
    pub pipeline: Vec<bson::Document>,
}

/// Translate a SQL string into an MQL pipeline using the cached schema.
#[allow(dead_code)]
pub fn translate(_sql: &str, _schema: &MongoSqlCatalog, _default_db: &str) -> Result<Translation> {
    Err(Error::Unimplemented("translate"))
}

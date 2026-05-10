//! Schema loader and cache. See ARCHITECTURE.md §3.
//!
//! Implementation arrives in T04 (Collection mode), T05 (File mode), T06 (cache + refresh).

use crate::error::{Error, Result};

/// Placeholder schema type; T04 will replace with the proper `mongosql::Catalog` wrapper.
#[derive(Debug, Default, Clone)]
pub struct MongoSqlCatalog;

/// Loads the schema from `__sql_schemas` in the configured database.
#[allow(dead_code)]
pub async fn load_from_collection(
    _client: &mongodb::Client,
    _db_name: &str,
) -> Result<MongoSqlCatalog> {
    Err(Error::Unimplemented("load_from_collection"))
}

/// Loads the schema from a YAML or JSON file.
#[allow(dead_code)]
pub fn load_from_file(_path: &std::path::Path) -> Result<MongoSqlCatalog> {
    Err(Error::Unimplemented("load_from_file"))
}

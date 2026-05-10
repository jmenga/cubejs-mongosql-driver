//! MongoSqlClient — orchestrates schema, translation, execution.
//!
//! Implementation arrives in T09.

use crate::config::ClientConfig;
use crate::error::Error;
use napi::Result as NapiResult;

/// Public napi-rs entry point. Cube's TypeScript driver instantiates this once
/// per Cube driver instance.
#[napi]
pub struct MongoSqlClient {
    // T09: mongo_client, schema_cache, refresh handle, config.
    _config: ClientConfig,
}

#[napi]
impl MongoSqlClient {
    /// Construct a new client. No I/O is performed.
    #[napi(constructor)]
    pub fn new(config: ClientConfig) -> NapiResult<Self> {
        Ok(Self { _config: config })
    }

    /// Verify cluster connectivity and load initial schema. Spawns the schema
    /// refresh task. See FR-1 in SPEC.md.
    #[napi]
    pub async fn test_connection(&self) -> NapiResult<()> {
        Err(Error::Unimplemented("MongoSqlClient::test_connection").into())
    }

    /// Translate `sql` and execute the resulting MQL pipeline. Returns rows
    /// as a JSON array. See FR-4.
    #[napi]
    pub async fn query(&self, _sql: String) -> NapiResult<serde_json::Value> {
        Err(Error::Unimplemented("MongoSqlClient::query").into())
    }

    /// Returns Cube's expected `tablesSchema` shape from the cached catalog.
    /// See FR-1.
    #[napi]
    pub async fn tables_schema(&self) -> NapiResult<serde_json::Value> {
        Err(Error::Unimplemented("MongoSqlClient::tables_schema").into())
    }

    /// Closes underlying connections and stops background tasks.
    #[napi]
    pub async fn close(&self) -> NapiResult<()> {
        Err(Error::Unimplemented("MongoSqlClient::close").into())
    }
}

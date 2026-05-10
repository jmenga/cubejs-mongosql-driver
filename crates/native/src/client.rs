//! MongoSqlClient — orchestrates schema, translation, execution.
//!
//! Implementation arrives in T09.

use crate::config::ClientConfig;
use crate::error::Error;
use napi::Result as NapiResult;

/// Placeholder error used by stubs until T04+ replace these methods with real
/// implementations. Maps to `MONGOSQL_EXECUTE_FAILED` so the surface looks
/// inert rather than misclassified.
fn unimplemented(what: &str) -> Error {
    Error::ExecuteFailed {
        msg: format!("not implemented yet (stub): {what}"),
    }
}

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
    /// Validation is deferred to `test_connection()` (FR-1) so the constructor
    /// stays infallible — napi-rs 2.16's `#[napi(constructor)]` requires `Self`
    /// directly, not `Result<Self>`.
    #[napi(constructor)]
    pub fn new(config: ClientConfig) -> Self {
        Self { _config: config }
    }

    /// Verify cluster connectivity and load initial schema. Spawns the schema
    /// refresh task. See FR-1 in SPEC.md.
    #[napi]
    pub async fn test_connection(&self) -> NapiResult<()> {
        Err(unimplemented("MongoSqlClient::test_connection").into())
    }

    /// Translate `sql` and execute the resulting MQL pipeline. Returns rows
    /// as a JSON array. See FR-4.
    ///
    /// As of T07 the translation half (`crate::translate::translate`) is
    /// available, but wiring it through here is deferred to T09 so that the
    /// query path lands together with the executor (T08) — partial wiring
    /// would change error semantics under tests with no compensating value.
    #[napi]
    pub async fn query(&self, _sql: String) -> NapiResult<serde_json::Value> {
        Err(unimplemented("MongoSqlClient::query").into())
    }

    /// Returns Cube's expected `tablesSchema` shape from the cached catalog.
    /// See FR-1.
    #[napi]
    pub async fn tables_schema(&self) -> NapiResult<serde_json::Value> {
        Err(unimplemented("MongoSqlClient::tables_schema").into())
    }

    /// Closes underlying connections and stops background tasks.
    #[napi]
    pub async fn close(&self) -> NapiResult<()> {
        Err(unimplemented("MongoSqlClient::close").into())
    }
}

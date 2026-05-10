//! MongoSqlClient — orchestrates schema, translation, execution.
//!
//! Public napi-rs entry point exposed via `lib.rs`. The Cube TypeScript driver
//! constructs one `MongoSqlClient` per data-source and then drives it via
//! `test_connection`, `query`, `tables_schema`, and `close`. See SPEC.md §5.2,
//! ARCHITECTURE.md §4.1, IMPLEMENTATION_PLAN.md T09.
//!
//! ## Lifecycle
//!
//! ```text
//! new(config)             → infallible; no I/O
//!   │
//!   ▼
//! test_connection().await → validate, connect, ping, load schema, spawn refresh
//!   │
//!   ▼
//! query(sql).await        → translate (against cached catalog) + execute
//! tables_schema().await   → render the cached column map as Cube's nested shape
//!   │
//!   ▼
//! close().await           → shut down refresh task; mongodb client drops via Arc
//! ```
//!
//! ## DB-name asymmetry (file mode)
//!
//! `load_from_file_with_columns` keys its catalog under
//! [`schema::FILE_MODE_DB_PLACEHOLDER`] because the file envelope carries no
//! database name. `query()` therefore passes the placeholder as `default_db`
//! to `translate::translate` for file-mode clients, then rewrites the
//! resulting `Translation::target_db` to `config.database` so the executor
//! actually runs against the configured cluster database. For collection-mode
//! the same pass-through becomes a no-op (catalog and config agree).
//!
//! `tables_schema()` similarly re-keys the column map under `config.database`
//! when the source is file mode, so consumers see a single coherent database
//! name regardless of how the schema was loaded.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::{Mutex, OnceCell};

use crate::config::ClientConfig;
use crate::error::{Error, Result};
use crate::execute;
use crate::schema::{
    self, LoadedSchema, SchemaCache, SchemaRefreshHandle, TableColumns, FILE_MODE_DB_PLACEHOLDER,
};
use crate::translate;

/// How long to wait for the initial `ping` admin command in `test_connection`.
/// Bounded so a misconfigured URI fails fast rather than hanging through the
/// full mongodb crate server-selection timeout (default 30s).
const PING_TIMEOUT: Duration = Duration::from_secs(10);

/// Public napi-rs entry point. Cube's TypeScript driver instantiates this once
/// per Cube driver instance.
#[napi]
pub struct MongoSqlClient {
    /// Effective config (defaults applied in [`Self::new`]).
    config: ClientConfig,
    /// Lazily-initialised mongodb client; first `test_connection` or `query`
    /// constructs it. Wrapped in `Arc` so the refresh task can hold its own
    /// strong reference without contending on `OnceCell`.
    mongo_client: OnceCell<Arc<mongodb::Client>>,
    /// Atomic schema cache shared with the background refresh task.
    schema_cache: SchemaCache,
    /// Parallel column-info store rendered as Cube's `tablesSchema` shape.
    /// Wrapped in a `Mutex` so refreshes can swap in new tables; readers take
    /// only a short clone.
    table_columns: Arc<Mutex<TableColumns>>,
    /// Handle to the background refresh task; populated by `test_connection`,
    /// taken (and `shutdown().await`-ed) by `close`.
    refresh_handle: Mutex<Option<SchemaRefreshHandle>>,
    /// Init-once guard for the schema-load + refresh-spawn stage of
    /// [`Self::test_connection`]. Concurrent callers block on the first
    /// caller's load; subsequent callers (after success) short-circuit.
    /// On `Err` the OnceCell stays uninitialised so a retry can re-attempt.
    init_once: OnceCell<()>,
    /// Total number of times the refresh task has been spawned for this
    /// client. Concurrent `test_connection()` calls must not race-spawn —
    /// after `test_connection` succeeds this is exactly 1, regardless of
    /// caller count. Always-on (single relaxed atomic increment) so tests
    /// can observe it without a `#[cfg(test)]` field.
    refresh_spawn_count: AtomicUsize,
}

#[napi]
impl MongoSqlClient {
    /// Construct a new client. No I/O is performed.
    ///
    /// Validation is deferred to [`Self::test_connection`] so the constructor
    /// stays infallible — napi-rs 2.16's `#[napi(constructor)]` requires
    /// `Self` directly, not `Result<Self>`. A subsequent `query()` before
    /// `test_connection()` returns a clear `MONGOSQL_CONFIG_INVALID` error
    /// rather than panicking.
    #[napi(constructor)]
    pub fn new(config: ClientConfig) -> Self {
        Self {
            config: config.with_defaults_applied(),
            mongo_client: OnceCell::new(),
            schema_cache: SchemaCache::new_empty(),
            table_columns: Arc::new(Mutex::new(TableColumns::new())),
            refresh_handle: Mutex::new(None),
            init_once: OnceCell::new(),
            refresh_spawn_count: AtomicUsize::new(0),
        }
    }

    /// Test-observability hook: how many times this client has spawned a
    /// refresh task. With the `init_once` guard in place this is at most 1
    /// across any number of concurrent `test_connection()` callers.
    #[doc(hidden)]
    pub fn refresh_spawn_count(&self) -> usize {
        self.refresh_spawn_count.load(Ordering::SeqCst)
    }

    /// Verify cluster connectivity and load initial schema, then spawn the
    /// background refresh task. Sequence:
    ///
    /// 1. `config.validate()` — synchronous shape checks (URI scheme, db name, ...).
    /// 2. Build the `mongodb::Client` (lazily; cached for subsequent calls).
    /// 3. `db("admin").run_command({ping: 1})` with a bounded timeout.
    /// 4. Initial schema load (collection or file mode).
    /// 5. Swap into the cache; build the column map.
    /// 6. Spawn the refresh task.
    ///
    /// Each step's failure preserves the SPEC §6 error code.
    #[napi]
    pub async fn test_connection(&self) -> napi::Result<()> {
        self.config.validate().map_err(napi::Error::from)?;
        let client = self.ensure_client().await.map_err(napi::Error::from)?;

        // Bounded ping. mongodb's own server-selection has a 30s default that
        // we want to avoid for a connectivity probe. Ping always runs (every
        // caller) so a transient network issue surfaces consistently across
        // callers — only schema-load + refresh-spawn is init-once-guarded.
        let ping = async {
            client
                .database("admin")
                .run_command(bson::doc! {"ping": 1_i32})
                .await
                .map(|_| ())
                .map_err(Error::from)
        };
        match tokio::time::timeout(PING_TIMEOUT, ping).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(napi::Error::from(e)),
            Err(_) => {
                return Err(napi::Error::from(Error::ConnectFailed {
                    msg: format!("ping timed out after {}s", PING_TIMEOUT.as_secs()),
                }));
            }
        }

        // Initial schema load + refresh spawn — guarded by `init_once` so
        // concurrent callers do this exactly once. Subsequent callers (after
        // success) short-circuit; if the first attempt fails the OnceCell
        // stays empty so a retry by any caller can re-attempt the work.
        // Without this guard, two concurrent callers would each spawn a
        // refresh task and the second would orphan the first's handle.
        self.init_once
            .get_or_try_init(|| async {
                let LoadedSchema { catalog, columns } = self.load_schema(client.as_ref()).await?;
                self.schema_cache.write(Arc::new(catalog));
                *self.table_columns.lock().await = columns;

                let handle = self.spawn_refresh(Arc::clone(&client));
                self.refresh_spawn_count.fetch_add(1, Ordering::SeqCst);
                *self.refresh_handle.lock().await = Some(handle);
                Ok::<(), Error>(())
            })
            .await
            .map_err(napi::Error::from)?;
        Ok(())
    }

    /// Translate `sql` and execute the resulting MQL pipeline. Returns rows
    /// as a JSON array.
    ///
    /// Database-name handling: for file-mode catalogs, `default_db` passed to
    /// `translate::translate` is [`FILE_MODE_DB_PLACEHOLDER`]; the resulting
    /// `Translation::target_db` is rewritten to `config.database` before the
    /// executor runs the aggregate, so the wire-level command targets the
    /// real database the user configured.
    #[napi]
    pub async fn query(&self, sql: String) -> napi::Result<Value> {
        let client = self.ensure_client().await.map_err(napi::Error::from)?;
        let catalog = self.schema_cache.read();
        let default_db = self.default_db_for_translate();

        let mut translation =
            translate::translate(&sql, &catalog, default_db).map_err(napi::Error::from)?;
        // Normalize the target database to the configured value. For
        // collection-mode this is a no-op (catalog and config already agree);
        // for file-mode this rewrites the placeholder to the real db.
        translation.target_db = self.config.database.clone();

        let timeout_ms = self
            .config
            .query_timeout_ms
            .unwrap_or(crate::config::DEFAULT_QUERY_TIMEOUT_MS);
        let max_rows = self
            .config
            .max_rows
            .unwrap_or(crate::config::DEFAULT_MAX_ROWS);

        execute::execute(client.as_ref(), translation, timeout_ms, max_rows)
            .await
            .map_err(napi::Error::from)
    }

    /// Returns Cube's expected `tablesSchema` payload built from the cached
    /// schema. Shape: `{ <db>: { <coll>: [{name, type}, ...] } }`.
    ///
    /// Only the configured database is exposed (one driver instance = one
    /// db). For file-mode catalogs the internal placeholder key is rewritten
    /// to the configured database name so consumers see a single coherent
    /// database label.
    #[napi]
    pub async fn tables_schema(&self) -> napi::Result<Value> {
        let columns = self.table_columns.lock().await.clone();
        let target_db = self.config.database.clone();

        let mut tables_for_db: Map<String, Value> = Map::new();
        for ((src_db, coll), cols) in &columns {
            // For collection-mode the source db must match config; for
            // file-mode the source db is the placeholder. In both cases we
            // expose under `config.database`.
            let belongs = src_db == &target_db || src_db == FILE_MODE_DB_PLACEHOLDER;
            if !belongs {
                continue;
            }
            let cols_json: Vec<Value> = cols
                .iter()
                .map(|c| {
                    let mut m = Map::new();
                    m.insert("name".to_string(), Value::String(c.name.clone()));
                    m.insert("type".to_string(), Value::String(c.sql_type.clone()));
                    m.insert("attributes".to_string(), Value::Array(Vec::new()));
                    Value::Object(m)
                })
                .collect();
            tables_for_db.insert(coll.clone(), Value::Array(cols_json));
        }

        let mut top: Map<String, Value> = Map::new();
        top.insert(target_db, Value::Object(tables_for_db));
        Ok(Value::Object(top))
    }

    /// Closes underlying connections and stops background tasks.
    ///
    /// Idempotent: calling `close()` after a previous `close()` (or before
    /// `test_connection()` ever spawned a refresh task) is a no-op rather
    /// than an error. The mongodb client itself has no explicit close on
    /// v3.x — its connection pool drops when the last `Arc<Client>` goes out
    /// of scope.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        if let Some(handle) = self.refresh_handle.lock().await.take() {
            handle.shutdown().await;
        }
        Ok(())
    }

    /// Lazily build the `mongodb::Client` for `config.uri`. Returns an
    /// `Arc<Client>` so callers can hand it to a background task without
    /// contending on the `OnceCell`.
    ///
    /// Uses `Client::with_uri_str` rather than `ClientOptions::parse` +
    /// `with_options` because the integration tests that exercise the
    /// underlying `mongodb` crate go through `with_uri_str` and we want the
    /// same code path under the napi surface. `with_uri_str` itself does the
    /// option parsing internally; the difference is documentation, not
    /// behaviour.
    async fn ensure_client(&self) -> Result<Arc<mongodb::Client>> {
        self.mongo_client
            .get_or_try_init(|| async {
                let client = mongodb::Client::with_uri_str(&self.config.uri).await?;
                Ok::<Arc<mongodb::Client>, Error>(Arc::new(client))
            })
            .await
            .cloned()
    }

    /// Load the initial / refreshed schema bundle based on config.
    async fn load_schema(&self, client: &mongodb::Client) -> Result<LoadedSchema> {
        match self.config.schema_source_kind() {
            "collection" => {
                schema::load_from_collection_with_columns(client, &self.config.database).await
            }
            "file" => {
                let path = self
                    .config
                    .schema_source
                    .as_ref()
                    .and_then(|s| s.path.as_ref())
                    .ok_or(Error::ConfigInvalid {
                        field: "schema_source.path",
                        reason: "required when schema_source.kind = \"file\"".to_string(),
                    })?;
                schema::load_from_file_with_columns(std::path::Path::new(path))
            }
            other => Err(Error::ConfigInvalid {
                field: "schema_source.kind",
                reason: format!("must be \"collection\" or \"file\"; got \"{other}\""),
            }),
        }
    }

    /// `current_db` value to pass to `translate::translate` based on whether
    /// the catalog was loaded in collection mode or file mode.
    fn default_db_for_translate(&self) -> &str {
        match self.config.schema_source_kind() {
            "file" => FILE_MODE_DB_PLACEHOLDER,
            // collection mode and any future modes default to the configured db.
            _ => self.config.database.as_str(),
        }
    }

    /// Spawn the background refresh task. The loader closure rebuilds the
    /// schema (catalog + columns), swaps the cache atomically, and updates
    /// the parallel `table_columns` map under its own lock. The closure
    /// captures clones of the per-client state so the task remains valid
    /// after `self` itself is moved/dropped.
    fn spawn_refresh(&self, client: Arc<mongodb::Client>) -> SchemaRefreshHandle {
        let refresh_sec = self
            .config
            .schema_refresh_sec
            .unwrap_or(crate::config::DEFAULT_SCHEMA_REFRESH_SEC) as u64;
        let cache = self.schema_cache.clone();
        let columns_mu = Arc::clone(&self.table_columns);
        let config = self.config.clone();

        schema::spawn_refresh_task(cache, refresh_sec, move || {
            let client = Arc::clone(&client);
            let columns_mu = Arc::clone(&columns_mu);
            let config = config.clone();
            async move {
                let LoadedSchema { catalog, columns } = load_for_refresh(&client, &config).await?;
                // Swap the column map alongside the catalog so consumers of
                // `tables_schema()` see consistent data.
                *columns_mu.lock().await = columns;
                Ok(catalog)
            }
        })
    }
}

/// Refresh-task variant of [`MongoSqlClient::load_schema`] with no `&self`
/// borrow so the closure can be `'static`.
async fn load_for_refresh(client: &mongodb::Client, config: &ClientConfig) -> Result<LoadedSchema> {
    match config.schema_source_kind() {
        "collection" => schema::load_from_collection_with_columns(client, &config.database).await,
        "file" => {
            let path = config
                .schema_source
                .as_ref()
                .and_then(|s| s.path.as_ref())
                .ok_or(Error::ConfigInvalid {
                    field: "schema_source.path",
                    reason: "required when schema_source.kind = \"file\"".to_string(),
                })?;
            schema::load_from_file_with_columns(std::path::Path::new(path))
        }
        other => Err(Error::ConfigInvalid {
            field: "schema_source.kind",
            reason: format!("must be \"collection\" or \"file\"; got \"{other}\""),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SchemaSource;

    fn fixture_config() -> ClientConfig {
        ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "mydb".to_string(),
            schema_source: Some(SchemaSource {
                kind: "collection".to_string(),
                path: None,
            }),
            schema_refresh_sec: Some(30),
            schema_fail_open: Some(false),
            query_timeout_ms: Some(5_000),
            max_rows: Some(1_000),
        }
    }

    #[test]
    fn constructor_stores_config_without_io() {
        let c = MongoSqlClient::new(fixture_config());
        // Config is the source of truth for downstream behaviour; verify the
        // input survived `with_defaults_applied` round-trip with our values.
        assert_eq!(c.config.database, "mydb");
        assert_eq!(c.config.schema_refresh_sec, Some(30));
        assert_eq!(c.config.query_timeout_ms, Some(5_000));
        assert_eq!(c.config.max_rows, Some(1_000));
        // No I/O means no client created, no refresh handle.
        assert!(c.mongo_client.get().is_none());
    }

    #[test]
    fn constructor_applies_defaults_for_unset_fields() {
        let c = MongoSqlClient::new(ClientConfig {
            uri: "mongodb://host/db".to_string(),
            database: "mydb".to_string(),
            schema_source: None,
            schema_refresh_sec: None,
            schema_fail_open: None,
            query_timeout_ms: None,
            max_rows: None,
        });
        assert_eq!(c.config.schema_source_kind(), "collection");
        assert_eq!(
            c.config.schema_refresh_sec,
            Some(crate::config::DEFAULT_SCHEMA_REFRESH_SEC)
        );
        assert_eq!(
            c.config.query_timeout_ms,
            Some(crate::config::DEFAULT_QUERY_TIMEOUT_MS)
        );
        assert_eq!(c.config.max_rows, Some(crate::config::DEFAULT_MAX_ROWS));
    }

    #[tokio::test]
    async fn close_is_idempotent_before_test_connection() {
        // close() before test_connection() must not panic and must succeed —
        // the refresh handle is None so there's nothing to shut down.
        let c = MongoSqlClient::new(fixture_config());
        c.close().await.expect("first close");
        c.close().await.expect("second close — must be idempotent");
    }

    #[tokio::test]
    async fn query_with_invalid_uri_returns_useful_error() {
        // ensure_client() parses the URI on first use; an empty URI must
        // surface a clear napi error with the SPEC §6 code prefix rather
        // than panicking.
        let mut cfg = fixture_config();
        cfg.uri = "not-a-valid-uri".to_string();
        let c = MongoSqlClient::new(cfg);
        let err = c
            .query("SELECT 1".to_string())
            .await
            .expect_err("query must fail without a valid URI");
        let msg = err.reason.clone();
        assert!(
            msg.starts_with("MONGOSQL_"),
            "error reason should be code-prefixed, got: {msg}"
        );
    }

    #[tokio::test]
    async fn test_connection_validates_config_first() {
        // An empty database fails the synchronous validate() check before any
        // I/O is attempted; this means the test passes even without Docker.
        let mut cfg = fixture_config();
        cfg.database = String::new();
        let c = MongoSqlClient::new(cfg);
        let err = c
            .test_connection()
            .await
            .expect_err("test_connection should reject empty db");
        assert!(err.reason.starts_with("MONGOSQL_CONFIG_INVALID"));
    }

    #[tokio::test]
    async fn tables_schema_before_load_returns_empty_db_object() {
        // Before any schema is loaded the column map is empty; the rendered
        // `{<db>: {}}` shape must still parse — Cube's introspection code
        // tolerates an empty schema, just not a missing one.
        let c = MongoSqlClient::new(fixture_config());
        let v = c.tables_schema().await.expect("tables_schema");
        let obj = v.as_object().expect("top level is an object");
        assert!(obj.contains_key("mydb"), "must expose configured db key");
        let inner = obj.get("mydb").and_then(|v| v.as_object()).expect("db obj");
        assert!(inner.is_empty(), "no tables loaded yet");
    }

    #[test]
    fn default_db_for_translate_routes_collection_vs_file_mode() {
        let collection_client = MongoSqlClient::new(fixture_config());
        assert_eq!(collection_client.default_db_for_translate(), "mydb");

        let mut file_cfg = fixture_config();
        file_cfg.schema_source = Some(SchemaSource {
            kind: "file".to_string(),
            path: Some("/tmp/x.yaml".to_string()),
        });
        let file_client = MongoSqlClient::new(file_cfg);
        assert_eq!(
            file_client.default_db_for_translate(),
            FILE_MODE_DB_PLACEHOLDER
        );
    }
}

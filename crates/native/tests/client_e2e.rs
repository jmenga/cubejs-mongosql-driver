//! Integration tests for [`MongoSqlClient`] against the docker-compose
//! atlas-local fixture. Loaded fixtures: `mongosql_test.{users,accounts,orders}`
//! plus their `__sql_schemas`. Run after `make e2e:up`:
//!
//! ```
//! cargo test -p cubejs-mongosql-driver-native --test client_e2e -- --ignored
//! ```
//!
//! All tests are `#[ignore]`-gated so the default `cargo test` invocation
//! does not require Docker. The atlas-local container exposes 27017 with
//! auth (`admin/admin` per `docker-compose.test.yml`); we connect with
//! `directConnection=true&authSource=admin` to bypass the SDAM redirect to
//! the unreachable internal hostname.
//!
//! Override the URI by exporting `MONGO_URI` before running the test.

#![allow(clippy::unwrap_used)]

use std::env;
use std::sync::Arc;

use cubejs_mongosql_driver_native::config::{ClientConfig, SchemaSource};
use cubejs_mongosql_driver_native::MongoSqlClient;
use serde_json::Value;

const DEFAULT_URI: &str =
    "mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true";
const TEST_DB: &str = "mongosql_test";

fn uri() -> String {
    env::var("MONGO_URI").unwrap_or_else(|_| DEFAULT_URI.to_string())
}

fn collection_mode_config() -> ClientConfig {
    ClientConfig {
        uri: uri(),
        database: TEST_DB.to_string(),
        schema_source: Some(SchemaSource {
            kind: "collection".to_string(),
            path: None,
        }),
        // Long enough that the refresh task does not fire during the test.
        schema_refresh_sec: Some(3600),
        schema_fail_open: Some(false),
        query_timeout_ms: Some(10_000),
        max_rows: Some(1_000),
    }
}

/// File-mode config pointing at the YAML fixture used by Rust schema-loader
/// tests. The fixture mirrors the data seeded into atlas-local so file-mode
/// queries return the same shape collection-mode queries do.
fn file_mode_config() -> ClientConfig {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = crate_dir
        .join("..")
        .join("..")
        .join("tests")
        .join("integration")
        .join("fixtures")
        .join("mongo-schema.yaml");
    ClientConfig {
        uri: uri(),
        database: TEST_DB.to_string(),
        schema_source: Some(SchemaSource {
            kind: "file".to_string(),
            path: Some(fixture.to_string_lossy().to_string()),
        }),
        schema_refresh_sec: Some(3600),
        schema_fail_open: Some(false),
        query_timeout_ms: Some(10_000),
        max_rows: Some(1_000),
    }
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn test_connection_succeeds_against_atlas_local() {
    let client = MongoSqlClient::new(collection_mode_config());
    client
        .test_connection(None)
        .await
        .expect("test_connection should succeed against the seeded fixture");
    client.close().await.expect("close after test_connection");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn query_count_returns_at_least_one_row() {
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection(None).await.expect("test_connection");

    let v = client
        .query("SELECT COUNT(*) FROM users".to_string(), None)
        .await
        .expect("count query");

    let (rows, types) = unwrap_query_result(&v);
    assert!(!rows.is_empty(), "COUNT(*) should return one aggregate row");
    // Critic v3 — Issue #3: pre-fix this test only asserted
    // `!types.is_empty()`, which passed even when the column was
    // mistyped as `text` (the `any_of: [Int, Long]` fallthrough). Now
    // we pin the actual contract: exactly one column, classified as
    // `bigint` (Int/Long union widens up, never `text`).
    assert_eq!(types.len(), 1, "single aggregate projection: {types:?}");
    let ty = types[0]
        .get("type")
        .and_then(|v| v.as_str())
        .expect("type string present");
    assert_eq!(
        ty, "bigint",
        "COUNT(*) must classify as bigint (Int/Long widening), got {ty}",
    );
    client.close().await.expect("close");
}

/// Critic v3 — Issue #3: lock the multi-column aggregate contract
/// against the real cluster. GROUP BY + SUM + COUNT exercises three
/// `any_of` shapes simultaneously; we assert each lands on the expected
/// Cube generic type. Pre-fix every column would have been `text` and
/// Cube Store would refuse to UNION partitions.
#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn group_by_aggregate_emits_correct_types_per_column() {
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection(None).await.expect("test_connection");

    let v = client
        .query(
            "SELECT account_id, SUM(amount) AS total, COUNT(*) AS c \
             FROM orders GROUP BY account_id"
                .to_string(),
            None,
        )
        .await
        .expect("group-by aggregate query");

    let (_rows, types) = unwrap_query_result(&v);
    // Build a name → type map; the SELECT projection order is
    // [account_id, total, c]. select_order is honoured byte-for-byte
    // (verified separately in translate.rs unit tests), so we don't
    // re-assert positional order here.
    let mut by_name: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for t in types {
        let obj = t.as_object().expect("column entry is object");
        let name = obj.get("name").and_then(|v| v.as_str()).expect("name");
        let ty = obj.get("type").and_then(|v| v.as_str()).expect("type");
        by_name.insert(name, ty);
    }
    assert_eq!(by_name.get("account_id"), Some(&"string"));
    assert_eq!(by_name.get("total"), Some(&"decimal"));
    assert_eq!(by_name.get("c"), Some(&"bigint"));
    client.close().await.expect("close");
}

/// Helper: pull `(rows, types)` out of the new `{rows, types}` query result.
fn unwrap_query_result(v: &Value) -> (&Vec<Value>, &Vec<Value>) {
    let obj = v.as_object().expect("query result is a JSON object");
    let rows = obj
        .get("rows")
        .and_then(|r| r.as_array())
        .expect("rows array present");
    let types = obj
        .get("types")
        .and_then(|t| t.as_array())
        .expect("types array present");
    (rows, types)
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn tables_schema_returns_seeded_namespaces() {
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection(None).await.expect("test_connection");

    let v = client.tables_schema(None).await.expect("tables_schema");
    let top = v.as_object().expect("top object");
    let db = top
        .get(TEST_DB)
        .and_then(|v| v.as_object())
        .expect("db key present");

    for table in &["users", "accounts", "orders"] {
        assert!(
            db.contains_key(*table),
            "expected `{table}` in tables_schema, got: {db:?}",
        );
        let cols = db
            .get(*table)
            .and_then(|v| v.as_array())
            .expect("table cols array");
        assert!(!cols.is_empty(), "table `{table}` should have columns");
        // Every column entry has name + type strings.
        for c in cols {
            let obj = c.as_object().expect("column object");
            assert!(obj.get("name").and_then(|v| v.as_str()).is_some());
            assert!(obj.get("type").and_then(|v| v.as_str()).is_some());
        }
    }
    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn close_stops_refresh_task() {
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection(None).await.expect("test_connection");
    // First close shuts down the refresh task; second close is idempotent.
    client.close().await.expect("first close");
    client.close().await.expect("second close — idempotent");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn file_mode_query_against_real_cluster() {
    // File-mode catalog keys under the placeholder; client.query() must rewrite
    // target_db to config.database so the executor reaches `mongosql_test`.
    let client = MongoSqlClient::new(file_mode_config());
    client.test_connection(None).await.expect("test_connection");

    let v = client
        .query("SELECT account_id FROM orders".to_string(), None)
        .await
        .expect("file-mode query");
    let (rows, _types) = unwrap_query_result(&v);
    assert!(!rows.is_empty(), "expected at least one orders row");
    client.close().await.expect("close");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn concurrent_test_connection_spawns_refresh_task_exactly_once() {
    // Critic v2 — Issue 1: prior to the `init_once` guard, two concurrent
    // `test_connection()` callers each spawned a refresh task and the second
    // overwrote `refresh_handle`, orphaning the first task forever. Spawn 8
    // concurrent callers and assert exactly one refresh task was registered.
    let client = Arc::new(MongoSqlClient::new(collection_mode_config()));
    assert_eq!(client.refresh_spawn_count(), 0, "no spawn before init");

    let mut handles = Vec::with_capacity(8);
    for _ in 0..8_u32 {
        let c = Arc::clone(&client);
        handles.push(tokio::spawn(async move { c.test_connection(None).await }));
        // (`None`: no abort signal — concurrency check focuses on init_once.)
    }
    for h in handles {
        h.await
            .expect("join")
            .expect("test_connection should succeed");
    }
    assert_eq!(
        client.refresh_spawn_count(),
        1,
        "init_once must collapse concurrent callers to a single refresh-task spawn",
    );

    // Idempotent: a subsequent test_connection after success must NOT spawn.
    client
        .test_connection(None)
        .await
        .expect("post-init reconnect");
    assert_eq!(client.refresh_spawn_count(), 1, "no extra spawn on retry");

    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn query_respects_max_rows_cap() {
    let mut cfg = collection_mode_config();
    cfg.max_rows = Some(1);
    let client = MongoSqlClient::new(cfg);
    client.test_connection(None).await.expect("test_connection");

    let err = client
        .query("SELECT * FROM orders".to_string(), None)
        .await
        .expect_err("max_rows=1 must trip ResultTooLarge");
    assert!(
        err.reason.starts_with("MONGOSQL_RESULT_TOO_LARGE"),
        "expected RESULT_TOO_LARGE, got: {}",
        err.reason
    );
    client.close().await.expect("close");
}

// ---------------------------------------------------------------------------
// Atlas SQL — real endpoint integration tests.
//
// Atlas SQL endpoints (`*.a.query.mongodb.net`) do NOT expose `__sql_schemas`
// as a queryable collection. The driver's `atlas-sql` mode discovers schemas
// via the `sqlGetSchema` admin-style command per Atlas documentation:
// https://www.mongodb.com/docs/sql-interface/schema/view/
//
// These tests run only when explicitly enabled. To run:
//
// ```
// ATLAS_SQL_URI="mongodb://USER:PASS@<endpoint>.a.query.mongodb.net/?ssl=true&authSource=admin" \
// ATLAS_SQL_DB="dev-convo-hub" \
// cargo test --release --test client_e2e -- --ignored atlas_sql
// ```
//
// Without the env vars the tests skip via `expect_atlas_sql_env()` (panics
// with a clear message under `--ignored`), so they never run accidentally
// during ordinary local development.
// ---------------------------------------------------------------------------

fn expect_atlas_sql_env() -> (String, String) {
    let uri = env::var("ATLAS_SQL_URI").unwrap_or_else(|_| {
        panic!(
            "atlas-sql integration tests require ATLAS_SQL_URI \
             (e.g. mongodb://USER:PASS@<endpoint>.a.query.mongodb.net/\
             ?ssl=true&authSource=admin)"
        )
    });
    let db = env::var("ATLAS_SQL_DB")
        .unwrap_or_else(|_| panic!("atlas-sql integration tests require ATLAS_SQL_DB"));
    (uri, db)
}

fn atlas_sql_mode_config(uri: String, db: String) -> ClientConfig {
    ClientConfig {
        uri,
        database: db,
        schema_source: Some(SchemaSource {
            kind: "atlas-sql".to_string(),
            path: None,
        }),
        schema_refresh_sec: Some(3600),
        schema_fail_open: Some(false),
        // Atlas SQL endpoints can be slower than atlas-local on cold paths
        // (TLS handshake + cloud round-trips); give the test a higher
        // budget than the collection-mode default.
        query_timeout_ms: Some(30_000),
        max_rows: Some(10_000),
    }
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB env vars"]
async fn atlas_sql_test_connection_succeeds_against_real_endpoint() {
    let (uri, db) = expect_atlas_sql_env();
    let client = MongoSqlClient::new(atlas_sql_mode_config(uri, db));
    client
        .test_connection(None)
        .await
        .expect("atlas-sql test_connection should succeed");
    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB env vars"]
async fn atlas_sql_tables_schema_returns_collections_with_schemas() {
    let (uri, db) = expect_atlas_sql_env();
    let client = MongoSqlClient::new(atlas_sql_mode_config(uri, db.clone()));
    client.test_connection(None).await.expect("test_connection");

    let v = client.tables_schema(None).await.expect("tables_schema");
    let top = v.as_object().expect("top object");
    let inner = top
        .get(&db)
        .and_then(|v| v.as_object())
        .unwrap_or_else(|| panic!("missing db key `{db}` in tables_schema output: {top:?}"));
    assert!(
        !inner.is_empty(),
        "expected at least one collection with a schema under `{db}`; got empty",
    );

    // Every entry must carry the standard `{name, type, attributes}` shape.
    for (coll_name, cols_value) in inner {
        let cols = cols_value
            .as_array()
            .unwrap_or_else(|| panic!("`{coll_name}` cols must be an array"));
        for c in cols {
            let obj = c.as_object().expect("column object");
            assert!(obj.get("name").and_then(|v| v.as_str()).is_some());
            assert!(obj.get("type").and_then(|v| v.as_str()).is_some());
        }
    }
    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB env vars"]
async fn atlas_sql_query_count_returns_row() {
    let (uri, db) = expect_atlas_sql_env();
    let client = MongoSqlClient::new(atlas_sql_mode_config(uri, db.clone()));
    client.test_connection(None).await.expect("test_connection");

    // Pick the first collection in the catalog dynamically so the test
    // is portable across endpoints (don't hard-code `calllogs`).
    let schema_v = client.tables_schema(None).await.expect("tables_schema");
    let coll = schema_v
        .as_object()
        .and_then(|m| m.get(&db))
        .and_then(|v| v.as_object())
        .and_then(|inner| inner.keys().next())
        .unwrap_or_else(|| panic!("no collections in catalog under `{db}`"))
        .clone();

    let sql = format!("SELECT COUNT(*) AS n FROM `{coll}`");
    let v = client.query(sql, None).await.expect("count query");

    let obj = v.as_object().expect("query result is JSON object");
    let rows = obj
        .get("rows")
        .and_then(|r| r.as_array())
        .expect("rows array");
    assert!(!rows.is_empty(), "COUNT(*) should return one aggregate row");

    let types = obj
        .get("types")
        .and_then(|t| t.as_array())
        .expect("types array");
    assert_eq!(types.len(), 1, "single aggregate projection");
    let ty = types[0]
        .get("type")
        .and_then(|v| v.as_str())
        .expect("type string");
    assert_eq!(ty, "bigint", "COUNT(*) classifies as bigint, got {ty}");
    client.close().await.expect("close");
}

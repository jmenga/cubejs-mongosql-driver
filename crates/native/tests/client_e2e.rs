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
        .test_connection()
        .await
        .expect("test_connection should succeed against the seeded fixture");
    client.close().await.expect("close after test_connection");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn query_count_returns_at_least_one_row() {
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection().await.expect("test_connection");

    let v = client
        .query("SELECT COUNT(*) FROM users".to_string())
        .await
        .expect("count query");

    let rows = match v {
        Value::Array(rows) => rows,
        other => panic!("expected JSON array, got {other:?}"),
    };
    assert!(!rows.is_empty(), "COUNT(*) should return one aggregate row");
    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn tables_schema_returns_seeded_namespaces() {
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection().await.expect("test_connection");

    let v = client.tables_schema().await.expect("tables_schema");
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
    client.test_connection().await.expect("test_connection");
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
    client.test_connection().await.expect("test_connection");

    let v = client
        .query("SELECT account_id FROM orders".to_string())
        .await
        .expect("file-mode query");
    match v {
        Value::Array(rows) => assert!(!rows.is_empty(), "expected at least one orders row"),
        other => panic!("expected JSON array, got {other:?}"),
    }
    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn query_respects_max_rows_cap() {
    let mut cfg = collection_mode_config();
    cfg.max_rows = Some(1);
    let client = MongoSqlClient::new(cfg);
    client.test_connection().await.expect("test_connection");

    let err = client
        .query("SELECT * FROM orders".to_string())
        .await
        .expect_err("max_rows=1 must trip ResultTooLarge");
    assert!(
        err.reason.starts_with("MONGOSQL_RESULT_TOO_LARGE"),
        "expected RESULT_TOO_LARGE, got: {}",
        err.reason
    );
    client.close().await.expect("close");
}

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
//!
//! ## SEED PREREQUISITE (MAJOR-5)
//!
//! Every test in this file (collection-mode + atlas-sql) requires the
//! seed scripts under `examples/docker/mongo-init/` (mounted by docker-
//! compose at `/docker-entrypoint-initdb.d/`) to have run against the
//! atlas-local container. The seed scripts populate
//! `mongosql_test.{users,accounts,orders,revenue_events}` AND the
//! companion `__sql_schemas` collection.
//!
//! If you spin atlas-local up via `make e2e:up` against a *fresh* volume
//! it runs automatically. If you previously ran the compose without
//! `revenue_events` (or with an older seed), the initdb hook may have
//! been skipped — atlas-local's initdb scripts only fire on a virgin
//! data directory. Re-seed manually:
//!
//! ```
//! docker exec mongosql-cubejs-driver-atlas mongosh \
//!   "mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true" \
//!   /docker-entrypoint-initdb.d/01-seed-data.js
//! ```
//!
//! Tests that fail with `MONGOSQL_SCHEMA_NOT_FOUND` or "no rows" on
//! known-seeded collections almost always indicate a missed seed step.

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

// ---------------------------------------------------------------------------
// Large IN-list — verifies pipeline_rewrite::flatten_or_chains_and_collapse_to_in
// defeats MongoDB's max-BSON-nested-object-depth (100) limit.
//
// The verified failure mode is: `mongosql::translate_sql` v1.8.5 outputs
// a FLAT `$or` (depth 1) both against the local YAML fixture AND against
// the real Atlas SQL endpoint's `sqlGetSchema`-derived catalog. When that
// flat array is sent to an Atlas SQL endpoint, the **proxy/server-side
// query layer re-expands** the array into a right-leaning chain of
// binary `$or`s before passing the aggregate to the underlying MongoDB
// query engine. For N ≥ ~100 that chain busts MongoDB's max BSON
// nested-object depth (100) and the server rejects the aggregate with
// `Error code 15 (Overflow): BSONObj exceeds maximum nested object
// depth`. Collapsing to `$in` defeats the re-expansion (no n-ary
// boolean array left to chain-ify).
//
// Three harnesses:
//  * `query_with_large_in_list_succeeds` — atlas-local with 201 string
//    values, SQL `WHERE account_id IN (…)`. The atlas-local fixture
//    catalog gives every `$eq` operand a `$$desugared_sqlOr_inputN`
//    variable LHS (mongosql's let-bound name), so the COLLAPSE precondition
//    is NOT met against this fixture — the rewriter only exercises the
//    flatten pass. Asserts end-to-end correctness of the flatten path.
//  * `query_with_large_in_list_collapse_against_atlas_local` — atlas-
//    local with a **manually-constructed pipeline** whose `$or` leaves
//    have bare-`$field` LHS (matching the Atlas SQL shape).
//    Bypasses the public `query()` path so the COLLAPSE precondition is
//    met and the rewriter produces a `$in`. Asserts (a) the post-
//    rewrite pipeline contains exactly one `$in`, (b) the server
//    accepts the query, (c) results match a control query expressed as
//    `IN (...)` via the public `query()` path.
//  * `query_with_large_in_list_against_atlas_sql` — atlas-sql; gated
//    on `ATLAS_SQL_URI` + `ATLAS_SQL_DB`. Exercises the real failure
//    mode where the proxy re-expands the flat $or — pre-fix this
//    overflows BSON depth, post-fix it succeeds.
// ---------------------------------------------------------------------------

/// Build a SQL string that selects rows by `account_id IN (v0..vN-1, "acct_a")`
/// — the last value matches one of the seeded `acct_a`/`acct_b` accounts so
/// the query has BOTH a non-trivial IN size AND a non-empty result set. The
/// matched value is `acct_a` (per `tests/integration/fixtures/seed-data.js`).
fn large_in_list_sql(coll: &str, n: usize) -> String {
    let mut sql = format!("SELECT account_id FROM `{coll}` WHERE account_id IN (");
    for i in 0..n {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'v{i}'"));
    }
    // Last value matches a seeded account_id, so we get a non-empty result.
    sql.push_str(", 'acct_a'");
    sql.push(')');
    sql
}

#[tokio::test]
#[ignore = "requires docker-compose + seeded atlas-local; run after `make e2e:up`. \
            Verifies the FLATTEN path end-to-end (the local fixture's \
            `$$desugared_sqlOr_inputN` variable-LHS shape blocks the \
            collapse precondition); for the COLLAPSE path see \
            `query_with_large_in_list_collapse_against_atlas_local`."]
async fn query_with_large_in_list_succeeds() {
    // Pre-fix: 200 values would either bust BSON depth (on atlas-sql) or
    // at minimum exercise an O(N)-deep pipeline. Post-fix: the rewriter
    // produces a flat `$or` array (the COLLAPSE precondition is
    // blocked here by the `$$desugared_sqlOr_inputN` variable LHS that
    // the local fixture catalog produces).
    //
    // The seed-data has 3 orders with `account_id = acct_a`, so the
    // post-fix query must return exactly 3 rows. Pre-fix on Atlas SQL
    // this would have failed with BSON depth overflow.
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection(None).await.expect("test_connection");

    let sql = large_in_list_sql("orders", 200);
    let v = client.query(sql, None).await.expect("large IN query");
    let obj = v.as_object().expect("object");
    let rows = obj
        .get("rows")
        .and_then(|r| r.as_array())
        .expect("rows array");
    assert_eq!(
        rows.len(),
        3,
        "expected exactly 3 acct_a orders to match; got rows={:?}",
        rows
    );
    client.close().await.expect("close");
}

/// MAJOR-3: drive the rewriter against a manually-constructed pipeline
/// matching the Atlas SQL shape (bare-`$field` LHS, literal RHS) so the
/// COLLAPSE precondition fires. Runs end-to-end against atlas-local,
/// asserts:
///   1. The rewriter produces a `$in` (count `$in` occurrences == 1 in
///      the final pipeline).
///   2. The server accepts and returns rows.
///   3. Results match a control query expressed via SQL `IN (...)`
///      through the public `query()` path.
#[tokio::test]
#[ignore = "requires docker-compose + seeded atlas-local; run after `make e2e:up`. \
            Exercises the COLLAPSE path by injecting a bare-`$field` LHS \
            pipeline (the local fixture's translator can't produce this \
            shape, so we synthesize it directly)."]
async fn query_with_large_in_list_collapse_against_atlas_local() {
    use bson::{doc, Bson};
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    use futures_util::TryStreamExt;
    use mongodb::Client as MongoClient;

    // 200 synthetic values + the real seed value `acct_a` (matches 3
    // orders). Build a right-leaning chain so we exercise both PASSES
    // (flatten + collapse) of the rewriter — same as what the Atlas
    // SQL proxy would re-expand server-side.
    let mut values: Vec<&str> = Vec::with_capacity(201);
    let synthetic: Vec<String> = (0..200).map(|i| format!("v{i}")).collect();
    for s in &synthetic {
        values.push(s.as_str());
    }
    values.push("acct_a");

    // Build a right-leaning chain `[L0, [L1, [L2, ..., [Ln-2, Ln-1]]]]`.
    let last_two = values.len() - 2;
    let mut current = doc! {
        "$or": [
            doc! {"$eq": ["$account_id", { "$literal": values[last_two] }]},
            doc! {"$eq": ["$account_id", { "$literal": values[last_two + 1] }]},
        ],
    };
    for i in (0..last_two).rev() {
        let leaf = doc! {"$eq": ["$account_id", { "$literal": values[i] }]};
        current = doc! {
            "$or": [Bson::Document(leaf), Bson::Document(current)],
        };
    }

    // Wrap in a `$match` stage so the executor accepts it.
    let mut pipeline: Vec<bson::Document> = vec![doc! {
        "$match": { "$expr": Bson::Document(current) },
    }];

    // Run the rewriter directly.
    flatten_or_chains_and_collapse_to_in(&mut pipeline);

    // ASSERTION 1: exactly one `$in` in the final pipeline; zero `$or`s.
    fn count_keys(b: &Bson, key: &str) -> usize {
        match b {
            Bson::Document(d) => {
                let here = d.iter().filter(|(k, _)| k.as_str() == key).count();
                let child: usize = d.iter().map(|(_, v)| count_keys(v, key)).sum();
                here + child
            }
            Bson::Array(a) => a.iter().map(|v| count_keys(v, key)).sum(),
            _ => 0,
        }
    }
    let in_count: usize = pipeline
        .iter()
        .map(|s| count_keys(&Bson::Document(s.clone()), "$in"))
        .sum();
    let or_count: usize = pipeline
        .iter()
        .map(|s| count_keys(&Bson::Document(s.clone()), "$or"))
        .sum();
    assert_eq!(
        in_count, 1,
        "rewriter must collapse the bare-`$field` chain to exactly one $in; got in_count={in_count}, or_count={or_count}",
    );
    assert_eq!(or_count, 0, "no $or remaining after collapse");

    // ASSERTION 2: server accepts the query and returns rows. Bypass
    // the `MongoSqlClient::query` path (which translates SQL via
    // mongosql); use the raw mongodb client.
    let mongo = MongoClient::with_uri_str(&uri())
        .await
        .expect("mongo client");
    let coll = mongo
        .database(TEST_DB)
        .collection::<bson::Document>("orders");
    let mut cursor = coll.aggregate(pipeline).await.expect("aggregate accepted");
    let mut rows: Vec<bson::Document> = Vec::new();
    while let Some(doc) = cursor.try_next().await.expect("cursor.next") {
        rows.push(doc);
    }
    assert_eq!(
        rows.len(),
        3,
        "manual-pipeline collapse path must return 3 acct_a orders; got {} rows",
        rows.len(),
    );
    for r in &rows {
        let acct = r.get_str("account_id").expect("account_id string");
        assert_eq!(
            acct, "acct_a",
            "matched row must have account_id == 'acct_a'; got {:?}",
            r,
        );
    }

    // ASSERTION 3: control query — same logical filter through the SQL
    // path. Must agree on the same row count.
    let client = MongoSqlClient::new(collection_mode_config());
    client.test_connection(None).await.expect("test_connection");
    let sql = large_in_list_sql("orders", 200);
    let control = client.query(sql, None).await.expect("control SQL query");
    let control_rows = control
        .as_object()
        .and_then(|o| o.get("rows"))
        .and_then(|r| r.as_array())
        .expect("control rows");
    assert_eq!(
        control_rows.len(),
        rows.len(),
        "control SQL path must match manual-pipeline path on row count",
    );
    client.close().await.expect("close");
}

/// MAJOR-3 / NOT-IN: drive the rewriter against a manually-constructed
/// `$and`-of-`$ne` pipeline matching the Atlas SQL NOT-IN shape, so the
/// COLLAPSE precondition fires for `$and → {$not: {$in: [...]}}`. Runs
/// end-to-end against atlas-local; asserts:
///   1. Exactly one `$not` (wrapping a `$in`) in the final pipeline;
///      zero `$and`s and zero `$nin`s (the latter is invalid in `$expr`).
///   2. The server accepts and returns rows.
///   3. Returned rows are the complement of the IN-list seed match
///      (3 `acct_a` orders are EXCLUDED; the remaining `acct_b` orders
///      are returned).
#[tokio::test]
#[ignore = "requires docker-compose + seeded atlas-local; run after `make e2e:up`. \
            Exercises the $and→$nin COLLAPSE path for the NOT IN failure mode."]
async fn query_with_large_not_in_list_collapse_against_atlas_local() {
    use bson::{doc, Bson};
    use cubejs_mongosql_driver_native::pipeline_rewrite::flatten_or_chains_and_collapse_to_in;
    use futures_util::TryStreamExt;
    use mongodb::Client as MongoClient;

    // 200 synthetic non-matching values + the real seed value `acct_a`
    // (which should be EXCLUDED by NOT IN). Build a right-leaning `$and`
    // chain matching the server-side re-expanded shape.
    let mut values: Vec<&str> = Vec::with_capacity(201);
    let synthetic: Vec<String> = (0..200).map(|i| format!("v{i}")).collect();
    for s in &synthetic {
        values.push(s.as_str());
    }
    values.push("acct_a");

    let last_two = values.len() - 2;
    let mut current = doc! {
        "$and": [
            doc! {"$ne": ["$account_id", { "$literal": values[last_two] }]},
            doc! {"$ne": ["$account_id", { "$literal": values[last_two + 1] }]},
        ],
    };
    for i in (0..last_two).rev() {
        let leaf = doc! {"$ne": ["$account_id", { "$literal": values[i] }]};
        current = doc! {
            "$and": [Bson::Document(leaf), Bson::Document(current)],
        };
    }

    let mut pipeline: Vec<bson::Document> = vec![doc! {
        "$match": { "$expr": Bson::Document(current) },
    }];
    flatten_or_chains_and_collapse_to_in(&mut pipeline);

    fn count_keys(b: &Bson, key: &str) -> usize {
        match b {
            Bson::Document(d) => {
                let here = d.iter().filter(|(k, _)| k.as_str() == key).count();
                let child: usize = d.iter().map(|(_, v)| count_keys(v, key)).sum();
                here + child
            }
            Bson::Array(a) => a.iter().map(|v| count_keys(v, key)).sum(),
            _ => 0,
        }
    }
    let not_count: usize = pipeline
        .iter()
        .map(|s| count_keys(&Bson::Document(s.clone()), "$not"))
        .sum();
    let nin_count: usize = pipeline
        .iter()
        .map(|s| count_keys(&Bson::Document(s.clone()), "$nin"))
        .sum();
    let in_count: usize = pipeline
        .iter()
        .map(|s| count_keys(&Bson::Document(s.clone()), "$in"))
        .sum();
    let and_count: usize = pipeline
        .iter()
        .map(|s| count_keys(&Bson::Document(s.clone()), "$and"))
        .sum();
    assert_eq!(
        not_count, 1,
        "rewriter must collapse the bare-`$field` $and chain to exactly one $not; got not_count={not_count}, and_count={and_count}, in_count={in_count}",
    );
    assert_eq!(
        in_count, 1,
        "the $not wraps a single $in (the only $in in the pipeline); got in_count={in_count}",
    );
    assert_eq!(
        nin_count, 0,
        "$nin must NEVER appear in $expr (rejected by server with code 168); got nin_count={nin_count}",
    );
    assert_eq!(and_count, 0, "no $and remaining after collapse");

    // Server accepts the query.
    let mongo = MongoClient::with_uri_str(&uri())
        .await
        .expect("mongo client");
    let coll = mongo
        .database(TEST_DB)
        .collection::<bson::Document>("orders");
    let mut cursor = coll.aggregate(pipeline).await.expect("aggregate accepted");
    let mut rows: Vec<bson::Document> = Vec::new();
    while let Some(doc) = cursor.try_next().await.expect("cursor.next") {
        rows.push(doc);
    }
    // Seed orders: 3 `acct_a` + 2 `acct_b` = 5 total. NOT IN excludes
    // `acct_a`, so 2 rows return (`acct_b`).
    assert_eq!(
        rows.len(),
        2,
        "NOT IN must return 2 `acct_b` orders; got {} rows: {:?}",
        rows.len(),
        rows,
    );
    for r in &rows {
        let acct = r.get_str("account_id").expect("account_id string");
        assert_eq!(acct, "acct_b", "NOT IN row must NOT be acct_a; got {:?}", r,);
    }
}

/// NOT IN coverage gap (per the critique): the Atlas SQL proxy
/// re-expands flat `$and`s just like it re-expands flat `$or`s. A
/// `NOT IN (200 values)` against a real Atlas SQL endpoint fails with
/// Error 15 (Overflow) — verified empirically. This test pins the
/// end-to-end fix against the real endpoint.
#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB env vars"]
async fn query_with_large_not_in_list_against_atlas_sql() {
    let (uri, db) = expect_atlas_sql_env();
    let client = MongoSqlClient::new(atlas_sql_mode_config(uri, db.clone()));
    client.test_connection(None).await.expect("test_connection");

    // Same collection/field discovery dance as the IN test.
    let schema_v = client.tables_schema(None).await.expect("tables_schema");
    let inner = schema_v
        .as_object()
        .and_then(|m| m.get(&db))
        .and_then(|v| v.as_object())
        .unwrap_or_else(|| panic!("no collections in catalog under `{db}`"));
    let (coll, field) = inner
        .iter()
        .find_map(|(coll_name, cols_value)| {
            let cols = cols_value.as_array()?;
            let f = cols.iter().find_map(|c| {
                let obj = c.as_object()?;
                let name = obj.get("name").and_then(|v| v.as_str())?;
                let ty = obj.get("type").and_then(|v| v.as_str())?;
                if name == "_id" {
                    return None;
                }
                if ty == "string" || ty == "text" {
                    Some(name.to_string())
                } else {
                    None
                }
            })?;
            Some((coll_name.clone(), f))
        })
        .unwrap_or_else(|| {
            panic!("could not find a string-typed column in any collection under `{db}`");
        });
    eprintln!("[atlas-sql large-NOT-IN test] using collection=`{coll}`, field=`{field}`");

    let mut sql = format!("SELECT COUNT(*) AS n FROM `{coll}` WHERE `{field}` NOT IN (");
    for i in 0..200 {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'large_not_in_list_test_v{i}'"));
    }
    sql.push(')');

    // Pre-fix: BSON depth overflow (Error 15). Post-fix: succeeds.
    let v = client
        .query(sql, None)
        .await
        .expect("large NOT IN query against atlas-sql must not overflow BSON depth");
    let obj = v.as_object().expect("object");
    assert!(obj.contains_key("rows"));
    assert!(obj.contains_key("types"));
    client.close().await.expect("close");
}

#[tokio::test]
#[ignore = "atlas-sql: requires ATLAS_SQL_URI + ATLAS_SQL_DB env vars"]
async fn query_with_large_in_list_against_atlas_sql() {
    // Real failure mode: 200 values against an Atlas SQL endpoint.
    // Pre-fix this would return MONGOSQL_QUERY_FAILED with a
    // server-side BSON depth overflow (Error code 15) because mongosql
    // emits the IN as a right-leaning binary-`$or` chain at the Atlas
    // SQL endpoint. Post-fix the rewriter flattens the chain (and
    // collapses to `$in` when safe), so the server accepts the query.
    let (uri, db) = expect_atlas_sql_env();
    let client = MongoSqlClient::new(atlas_sql_mode_config(uri, db.clone()));
    client.test_connection(None).await.expect("test_connection");

    // Pick a collection dynamically (don't assume `orders` exists on
    // the target Atlas SQL endpoint), and pick a string field from its
    // schema dynamically so we don't depend on a particular field
    // naming convention (`account_id` vs `accountId`).
    let schema_v = client.tables_schema(None).await.expect("tables_schema");
    let inner = schema_v
        .as_object()
        .and_then(|m| m.get(&db))
        .and_then(|v| v.as_object())
        .unwrap_or_else(|| panic!("no collections in catalog under `{db}`"));
    // Find the first (collection, string-typed field) pair we encounter.
    let (coll, field) = inner
        .iter()
        .find_map(|(coll_name, cols_value)| {
            let cols = cols_value.as_array()?;
            let f = cols.iter().find_map(|c| {
                let obj = c.as_object()?;
                let name = obj.get("name").and_then(|v| v.as_str())?;
                let ty = obj.get("type").and_then(|v| v.as_str())?;
                // Skip `_id` so we don't get coerced into an
                // ObjectId-vs-string type mismatch. Any other string
                // column is fine — the rewriter is field-agnostic.
                if name == "_id" {
                    return None;
                }
                if ty == "string" || ty == "text" {
                    Some(name.to_string())
                } else {
                    None
                }
            })?;
            Some((coll_name.clone(), f))
        })
        .unwrap_or_else(|| {
            panic!("could not find a string-typed column in any collection under `{db}`");
        });
    eprintln!("[atlas-sql large-IN test] using collection=`{coll}`, field=`{field}`");

    // Build SQL with 200 synthetic values. The query targets a real
    // (collection, field) so the server's actual query path runs
    // (i.e. translation + execution against real data). The synthetic
    // values almost certainly don't match any rows; that's fine — the
    // test asserts the query SUCCEEDS, not what it returns.
    let mut sql = format!("SELECT COUNT(*) AS n FROM `{coll}` WHERE `{field}` IN (");
    for i in 0..200 {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("'large_in_list_test_v{i}'"));
    }
    sql.push(')');
    // The core assertion is that the query SUCCEEDS — pre-fix this
    // would panic on the server-side BSON depth overflow. The row
    // count is incidental (mongosql collapses an empty COUNT(*) to
    // zero rows when there's no group key and no matches), and we
    // explicitly do NOT assert on it.
    let v = client
        .query(sql, None)
        .await
        .expect("large IN query against atlas-sql must not overflow BSON depth");
    let obj = v.as_object().expect("object");
    // We just check the response is well-formed.
    assert!(obj.contains_key("rows"));
    assert!(obj.contains_key("types"));
    client.close().await.expect("close");
}

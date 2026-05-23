//! Integration tests for [`driver::execute::execute`] against the docker-
//! compose atlas-local fixture. Loaded fixtures: `mongosql_test.{users,
//! accounts,orders}` plus their `__sql_schemas`. Run after `make e2e:up`:
//!
//! ```
//! cargo test -p cubejs-mongosql-driver-native --test execute_integration -- --ignored
//! ```
//!
//! All tests are `#[ignore]`-gated so the default `cargo test` invocation
//! does not require Docker. The atlas-local container exposes 27017 with
//! auth (`admin/admin` per `docker-compose.test.yml`), so we connect with
//! `directConnection=true&authSource=admin` to bypass the SDAM redirect to
//! the unreachable internal hostname.
//!
//! Override the URI by exporting `MONGO_URI` before running the test.

#![allow(clippy::unwrap_used)]

use std::env;

use cubejs_mongosql_driver_native as driver;
use mongodb::Client;

const DEFAULT_URI: &str =
    "mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true";
const TEST_DB: &str = "mongosql_test";

fn uri() -> String {
    env::var("MONGO_URI").unwrap_or_else(|_| DEFAULT_URI.to_string())
}

/// End-to-end happy path: translate a simple SELECT-WHERE, execute it,
/// assert the row shape and at least one row matches the expected filter.
#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn execute_select_where_returns_filtered_rows() {
    let client = Client::with_uri_str(uri()).await.expect("connect");
    let catalog = driver::schema::load_from_collection(&client, TEST_DB)
        .await
        .expect("load catalog from __sql_schemas");

    let translation = driver::translate::translate(
        "SELECT account_id, status FROM orders WHERE status = 'paid'",
        &catalog,
        TEST_DB,
    )
    .expect("translate");

    let result = driver::execute::execute(&client, translation, 10_000, 100)
        .await
        .expect("execute");

    let rows = result.rows.clone();
    assert!(!rows.is_empty(), "expected at least one paid order");
    // The (name, type) list must follow the SELECT projection order
    // exactly — `account_id` first, `status` second — regardless of
    // what `Object.keys(firstRow)` would yield.
    let names: Vec<&str> = result.types.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["account_id", "status"],
        "types must match projection order"
    );
    // Both columns originate from the orders schema; account_id is
    // typed `string` (objectId/string) and status is `string`.
    for c in &result.types {
        assert_eq!(c.ty, "string", "{} should be classified as string", c.name);
    }

    // mongosql output is shaped as `{"<table_alias>": {<fields...>}}` per
    // its result-schema contract — it wraps each row in its source-table
    // namespace so projections survive joins. Walk the row recursively to
    // find the `status` and `account_id` leaf fields rather than coupling
    // to mongosql's exact wrapping shape (which can shift between versions).
    fn find_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
        match value {
            serde_json::Value::Object(map) => {
                if let Some(s) = map.get(key).and_then(|v| v.as_str()) {
                    return Some(s);
                }
                for v in map.values() {
                    if let Some(s) = find_string(v, key) {
                        return Some(s);
                    }
                }
                None
            }
            _ => None,
        }
    }

    for row in &rows {
        let status = find_string(row, "status").expect("row should carry status leaf");
        assert_eq!(
            status, "paid",
            "WHERE clause should restrict to paid orders; row={row}"
        );
        assert!(
            find_string(row, "account_id").is_some(),
            "row should carry account_id leaf; row={row}",
        );
    }
}

/// Critic v3 — Issue #3: drive a GROUP BY + SUM + COUNT through the
/// executor end-to-end (real mongosql, real mongo cluster) and assert
/// every column lands on the correct Cube generic type. Pre-fix all
/// three would have been `text` (the `any_of` fallback bug).
#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn execute_group_by_aggregate_emits_correct_types() {
    let client = Client::with_uri_str(uri()).await.expect("connect");
    let catalog = driver::schema::load_from_collection(&client, TEST_DB)
        .await
        .expect("load catalog");

    let translation = driver::translate::translate(
        "SELECT account_id, SUM(amount) AS total, COUNT(*) AS c \
         FROM orders GROUP BY account_id",
        &catalog,
        TEST_DB,
    )
    .expect("translate");

    let result = driver::execute::execute(&client, translation, 10_000, 100)
        .await
        .expect("execute");

    // Build name → type map. Positional order is locked in translate.rs
    // unit tests (Vec<Vec<String>> select_order is deterministic across
    // translations); here we want to confirm that the per-column type
    // mapping survives the wire trip.
    let by_name: std::collections::HashMap<&str, &str> = result
        .types
        .iter()
        .map(|c| (c.name.as_str(), c.ty))
        .collect();
    assert_eq!(
        by_name.get("account_id"),
        Some(&"string"),
        "account_id should be string, full types={:?}",
        result.types,
    );
    assert_eq!(
        by_name.get("total"),
        Some(&"decimal"),
        "SUM(decimal) should classify as decimal, full types={:?}",
        result.types,
    );
    assert_eq!(
        by_name.get("c"),
        Some(&"bigint"),
        "COUNT(*) should widen Int+Long to bigint, full types={:?}",
        result.types,
    );
    assert!(
        !result.rows.is_empty(),
        "GROUP BY over seeded orders should produce at least one row",
    );
}

/// Row-cap enforcement: the seeded fixture has multiple `orders` rows; with
/// `max_rows = 1` the second row triggers `Error::ResultTooLarge`.
#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn execute_enforces_max_rows_cap() {
    let client = Client::with_uri_str(uri()).await.expect("connect");
    let catalog = driver::schema::load_from_collection(&client, TEST_DB)
        .await
        .expect("load catalog");

    let translation =
        driver::translate::translate("SELECT * FROM orders", &catalog, TEST_DB).expect("translate");

    let err = driver::execute::execute(&client, translation, 10_000, 1)
        .await
        .expect_err("expected ResultTooLarge");
    assert_eq!(err.code(), "MONGOSQL_RESULT_TOO_LARGE");
}

//! Integration test for `schema::load_from_collection` against the docker
//! compose stack defined in `tests/integration/docker-compose.test.yml`.
//!
//! The test is `#[ignore]` so it does NOT run as part of the default
//! `cargo test` invocation. Run explicitly with:
//!
//! ```
//! make e2e:up   # or `docker compose -f tests/integration/docker-compose.test.yml up -d`
//! cargo test -p cubejs-mongosql-driver-native --test schema_collection -- --ignored
//! ```
//!
//! The atlas-local container exposes port 27017 with auth required
//! (admin/admin per `docker-compose.test.yml`). Atlas-local is itself a
//! single-node replica set, so we connect with `directConnection=true` to
//! skip the SRV/SDAM step that would otherwise resolve to the container's
//! internal hostname (`<containerId>:27017`) and fail from the host.
//!
//! Override the URI by exporting `MONGO_URI` before running the test.

use std::env;

use agg_ast::definitions::Namespace;
use cubejs_mongosql_driver_native as driver;
use mongodb::Client;

const DEFAULT_URI: &str =
    "mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true";
const TEST_DB: &str = "mongosql_test";

#[tokio::test]
#[ignore = "requires docker-compose; run with --ignored after `make e2e:up`"]
async fn loads_seeded_catalog_from_sql_schemas() {
    let uri = env::var("MONGO_URI").unwrap_or_else(|_| DEFAULT_URI.to_string());
    let client = Client::with_uri_str(&uri)
        .await
        .expect("connect to atlas-local");

    let catalog = driver::schema::load_from_collection(&client, TEST_DB)
        .await
        .expect("load_from_collection on seeded fixtures");

    for coll in &["users", "accounts", "orders"] {
        let ns = Namespace {
            database: TEST_DB.to_string(),
            collection: (*coll).to_string(),
        };
        assert!(
            catalog.get_schema_for_namespace(&ns).is_some(),
            "expected catalog to contain `{TEST_DB}.{coll}` after loading __sql_schemas",
        );
    }

    // Spot-check a known field on at least one collection — the seed-schemas
    // fixture defines `orders.account_id: string`. We don't fully introspect
    // the parsed `mongosql::schema::Schema` here (its variants are large) but
    // we ensure presence-of-namespace, which proves the doc parsed cleanly.
    let orders_ns = Namespace {
        database: TEST_DB.to_string(),
        collection: "orders".to_string(),
    };
    let orders_schema = catalog
        .get_schema_for_namespace(&orders_ns)
        .expect("orders namespace present");
    let dbg = format!("{orders_schema:?}");
    assert!(
        dbg.contains("account_id"),
        "orders schema should mention account_id; got: {dbg}",
    );
}

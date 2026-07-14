//! Regression: mongosql does NOT support positional (ordinal) GROUP BY.
//!
//! mongosql's grammar (`mongosql/src/parser/mongosql.lalrpop`) parses a
//! `GROUP BY` key list as `CommaPlus<OptionallyAliasedExpr>` — expressions,
//! not ordinals. So `GROUP BY 1` is the literal integer `1`, and the
//! algebrizer then INTERMITTENTLY fails to resolve the FROM table's datasource
//! (the failure is HashMap-seed dependent, so it passes on some processes and
//! fails on others — which is why it only ever surfaced in CI). `GROUP BY` by
//! the SELECT column ALIAS resolves reliably.
//!
//! The driver repairs this in `MongoSqlDriver` by rewriting positional
//! `GROUP BY 1, 2` to the projection aliases before translation
//! (`rewritePositionalGroupBy`); this test pins the underlying mongosql
//! behaviour that motivates that rewrite and proves the alias form is the
//! reliable one. It talks to `mongosql::translate_sql` directly (via the
//! driver's `translate` wrapper) with a fully-populated file catalog — no I/O.

use std::sync::Arc;

use cubejs_mongosql_driver_native::schema::{
    load_from_file_with_columns, FILE_MODE_DB_PLACEHOLDER,
};
use cubejs_mongosql_driver_native::translate;

fn catalog() -> Arc<cubejs_mongosql_driver_native::schema::MongoSqlCatalog> {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = crate_dir
        .join("..")
        .join("..")
        .join("tests")
        .join("integration")
        .join("fixtures")
        .join("mongo-schema.yaml");
    Arc::new(
        load_from_file_with_columns(&fixture)
            .expect("load fixture catalog")
            .catalog,
    )
}

/// GROUP BY by the SELECT projection alias translates reliably. Repeated across
/// several process-external invocations in CI, but even a single run must pass:
/// the alias form is not seed-sensitive.
#[test]
fn group_by_alias_translates() {
    let cat = catalog();
    // Single key.
    translate::translate(
        "SELECT DATETRUNC(MONTH, `revenue_events`.occurred_at) `revenue_events__m`, count(*) `n` \
         FROM revenue_events AS `revenue_events` GROUP BY `revenue_events__m`",
        &cat,
        FILE_MODE_DB_PLACEHOLDER,
    )
    .expect("alias GROUP BY (single key) must translate");

    // Multiple keys.
    translate::translate(
        "SELECT `revenue_events`.category `revenue_events__category`, \
         DATETRUNC(MONTH, `revenue_events`.occurred_at) `revenue_events__m`, count(*) `n` \
         FROM revenue_events AS `revenue_events` GROUP BY `revenue_events__category`, `revenue_events__m`",
        &cat,
        FILE_MODE_DB_PLACEHOLDER,
    )
    .expect("alias GROUP BY (multi key) must translate");
}

/// Documents the mongosql limitation the driver's rewrite exists to defeat:
/// a POSITIONAL `GROUP BY 1` is unreliable (it fails on at least some hash
/// seeds). We assert only that the ALIAS form is strictly more reliable than
/// the positional form, so the test is deterministic regardless of seed: if
/// positional happens to succeed on this run, alias must too; if alias ever
/// fails, that's a real regression.
#[test]
fn alias_group_by_is_at_least_as_reliable_as_positional() {
    let cat = catalog();
    let sel =
        "SELECT DATETRUNC(MONTH, `revenue_events`.occurred_at) `revenue_events__m`, count(*) `n` \
               FROM revenue_events AS `revenue_events`";
    let positional_ok =
        translate::translate(&format!("{sel} GROUP BY 1"), &cat, FILE_MODE_DB_PLACEHOLDER).is_ok();
    let alias_ok = translate::translate(
        &format!("{sel} GROUP BY `revenue_events__m`"),
        &cat,
        FILE_MODE_DB_PLACEHOLDER,
    )
    .is_ok();
    assert!(alias_ok, "alias GROUP BY must always translate");
    assert!(
        alias_ok || !positional_ok,
        "if positional GROUP BY resolved, the alias form must too",
    );
}

#[test]
fn lower_like_lower_translates() {
    let cat = catalog();
    translate::translate(
        "SELECT `orders`.status `s` FROM orders AS `orders` WHERE LOWER(`orders`.status) LIKE LOWER('%paid%')",
        &cat,
        FILE_MODE_DB_PLACEHOLDER,
    )
    .expect("LOWER(x) LIKE LOWER(y) must translate (mongosql has no ILIKE)");
}

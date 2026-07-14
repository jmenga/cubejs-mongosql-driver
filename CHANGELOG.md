# Changelog

## 1.0.1

### Patch Changes

- [#3](https://github.com/jmenga/cubejs-mongosql-driver/pull/3) [`c396191`](https://github.com/jmenga/cubejs-mongosql-driver/commit/c396191e278b067736ebf76d4c362ad63c14a1a9) Thanks [@jmenga](https://github.com/jmenga)! - Fix `query()` / `downloadQueryResults()` / `tablesSchema()` translating against an empty schema catalog when `testConnection()` hadn't primed it.

  The native schema load + background refresh spawn used to run only inside `test_connection()`. A host (notably Cube's pre-aggregation refresh worker, `PreAggregationLoader.refreshReadOnlyExternalStrategy` → `driver.downloadQueryResults(...)`) that invoked a query path on a driver instance whose `testConnection()` had not run first translated against an empty catalog, so every translate failed with a misleading mongosql algebrize error (`Error 3008 ... cannot be resolved to any datasource`) rather than a real schema/data problem — crash-looping the pod.

  The query paths now share the same `OnceCell`-guarded load via a new `ensure_schema_loaded()` in the native client, so they lazily prime the catalog (idempotent and race-safe) before translating. `test_connection()` remains the conventional priming step and additionally performs the bounded connectivity ping; it is no longer a precondition for querying. Applies to all `schemaSource` modes (`collection`, `file`, `atlas-sql`).

  Additional robustness/dialect fixes in the same change:

  - **Self-healing schema cache.** A successful-but-empty schema load is no longer cached as final, and the background refresh never overwrites a good catalog with an empty one — so a driver that first loaded before its database was reachable/seeded recovers instead of staying stuck until the next refresh.
  - **Positional `GROUP BY`.** mongosql does not support ordinal `GROUP BY` (`GROUP BY 1` is the literal integer, which its algebrizer then intermittently fails to resolve). The driver now rewrites positional `GROUP BY` to the SELECT projection aliases, which mongosql resolves reliably.
  - **`ILIKE`.** mongosql has no `ILIKE`; the dialect's tesseract template path now emits `LOWER(expr) LIKE LOWER(pattern)` (matching the existing `likeIgnoreCase` filter rewrite).

All notable changes to `@effectuate/cubejs-mongosql-driver` will be documented
in this file. See [Changesets](https://github.com/changesets/changesets) for
the source of truth.

## 1.0.0

### Major Changes

- Initial release as `@effectuate/cubejs-mongosql-driver`. Cube.js native
  data-source driver for MongoDB via the MongoSQL translator (Rust +
  napi-rs). Drop-in replacement for the EOL-bound BI Connector
  (`@cubejs-backend/mongobi-driver`) path.

  **What works:**

  - SQL → MQL translation via the upstream `mongosql` crate (v1.8.5).
  - Schema introspection in three modes: `collection` (reads
    `__sql_schemas`), `file` (YAML / JSON), and `atlas-sql` (Atlas SQL
    `sqlGetSchema` admin command for cluster-side schemas).
  - Cube-driver protocol: `query`, `tablesSchema`, the
    `incrementalSchemaLoading` three-method suite, `downloadQueryResults`,
    AbortSignal-driven cancellation, `release`.
  - Pre-aggregations: refresh keys, incremental refresh windows, partitioned
    rollups, build-range queries.
  - Pipeline rewrites that work around the MongoDB BSON depth-100 limit
    triggered by the Atlas SQL proxy re-expanding large `$or` arrays:
    flatten right-leaning `$or` chains, collapse same-field `$eq`/`$ne`
    disjunctions to `$in`/`$nin`, and collapse mongosql's `$let`-wrapped
    IN-list shape (emitted when `IN (…)` co-exists with `GROUP BY`).
  - Row-shape normalization: null-fills missing keys so Cube's first-row
    column-sniff doesn't drop columns from sparse result sets.
  - Dialect overrides for mongosql v1.8.5 grammar quirks: `LOWER(col) LIKE
LOWER(pattern)` instead of `ILIKE`, named GROUP BY / ORDER BY refs
    instead of positional, no `INTERVAL` keyword in arithmetic.

  **Prebuilt binaries** for `linux-x64-gnu`, `linux-arm64-gnu`,
  `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`.

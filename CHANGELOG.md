# Changelog

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

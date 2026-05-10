# `mongosql-cubejs-driver` — Specification

**Status:** Draft v1
**Last reviewed:** 2026-05-09
**Audience:** Implementing agents and human contributors. Self-contained — assume readers have no prior conversation context.

## 1. Purpose

A native Cube.js data source driver that lets Cube query MongoDB Atlas (or self-hosted MongoDB Enterprise Advanced) using SQL. The driver translates SQL → MongoDB Aggregation Pipeline (MQL) client-side via the open-source [`mongosql`](https://github.com/mongodb/mongosql) Rust crate, then executes the pipeline via the official [`mongodb`](https://crates.io/crates/mongodb) Rust crate.

This driver replaces the EOL'd MongoDB BI Connector (`mongosqld`) path that Cube users have relied on. The BI Connector reaches end-of-life on **30 September 2026**.

## 2. Non-goals

- **Not a JDBC bridge.** No JVM dependency.
- **Not a CDC/warehouse approach.** Direct MongoDB queries only.
- **No SQL→MQL translator implementation.** We consume the open-source `mongosql` crate as-is.
- **No Federation routing.** Connect directly to MongoDB clusters; do not require Atlas Data Federation in the query path.
- **No bundled schema sampler.** Schema population is a deployment concern (Atlas-managed sampler, EA Schema Builder CLI, or DIY).

## 3. Functional requirements

### FR-1 — Cube driver protocol

Implement Cube's `BaseDriver` interface. The driver MUST:

- Accept a SQL string via `query(sql, values?)` and return rows as a JSON array.
- Implement `testConnection()` — verifies cluster connectivity AND schema availability; fails on either.
- Implement `tablesSchema()` — returns Cube's expected table-introspection format, sourced from the cached schema.
- Implement `release()` — closes the underlying MongoDB connection pool and stops background tasks.
- Provide a `static dialectClass()` returning the `MongoSqlQuery` class for SQL generation.

### FR-2 — SQL dialect

Implement `MongoSqlQuery extends BaseQuery` to generate MongoSQL-flavoured SQL. Required adjustments from SQL-92:

| Feature | Standard SQL | MongoSQL | Action in dialect |
|---|---|---|---|
| Date type | `DATE` | (unsupported) | Substitute `TIMESTAMP` |
| Date interval arithmetic | `INTERVAL '1 day'` | (unsupported) | Rewrite as MongoSQL date-function calls |
| Document path | `(json_extract...)` | `field.subfield` | Use MongoSQL document syntax |
| Array projection | (vendor-specific) | `UNWIND` / array-index syntax | Map to MongoSQL forms |
| Identifier quoting | varies | backtick-quoted | Override quote chars |

Reference: https://www.mongodb.com/docs/sql-interface/language-reference/

### FR-3 — Schema management

The driver MUST support two schema source modes, selected by env var:

| Mode | Source | Use case |
|---|---|---|
| `collection` (default) | `__sql_schemas` collection in the connected database | Production (Atlas-managed or EA Schema Builder) |
| `file` | YAML or JSON file at a configured path | Local dev, schema-as-code, edge cases |

The driver MUST:

- Load schema once on `testConnection()`. Fail-closed if unavailable.
- Cache schema in memory (`Arc<RwLock<Schema>>` on the Rust side).
- Refresh schema on a configurable interval (default: 300s) via a background task.
- On refresh failure: log warning, keep serving cached schema, retry next interval.
- Atomically swap cache contents on successful refresh.
- Never block query execution on schema I/O.

### FR-4 — Query execution

The driver MUST:

- Translate every SQL query through `mongosql::translate_sql(default_db, sql, &Catalog, SqlOptions)` using the cached `Catalog`.
- Inspect the returned `Translation.target_collection: Option<String>`:
  - `Some(name)` → run as `db.<name>.aggregate(pipeline)`
  - `None` → run as a database-level aggregate (`db.aggregate(pipeline)`) — for queries that span or operate independently of any single collection
- Send the resulting MQL pipeline (`Translation.pipeline: bson::Bson`) to MongoDB through the official `mongodb` Rust crate.
- Drain the cursor up to `CUBEJS_MONGOSQL_MAX_ROWS`; throw `MONGOSQL_RESULT_TOO_LARGE` if the cap is exceeded.
- Marshal BSON values to JSON-compatible primitives the Node side can consume.
- Surface translation errors and execution errors with clear, actionable messages — wrapped in Cube's expected error shapes where applicable.

### FR-5 — Authentication

The driver MUST support all MongoDB auth mechanisms supported by the official `mongodb` Rust crate (since auth is delegated to the upstream driver). The driver itself does not implement auth logic.

Documented and tested support:

- **SCRAM-SHA-256** (username/password)
- **MONGODB-AWS** (AWS IAM — required for AWS deployments using EKS Pod Identity)
- **MONGODB-X509** (certificate-based)

OIDC and Kerberos are inherited from the upstream Rust driver but not first-class targets.

### FR-6 — Pre-aggregations

The driver MUST work with Cube pre-aggregations:

- Partitioned pre-aggs (`partition_granularity`)
- Incremental refresh (`incremental: true` + `update_window`)
- Time-based and SQL-based refresh keys
- Build-range (`build_range_start` / `build_range_end`)

`CUBEJS_DB_EXPORT_BUCKET` (S3 UNLOAD) is NOT supported (MongoDB has no equivalent). Pre-agg builds stream through the driver to Cube Store.

### FR-7 — Configuration

All configuration via standard Cube env vars where they exist; new `CUBEJS_MONGOSQL_*` vars where they don't.

| Env var | Required? | Default | Purpose |
|---|---|---|---|
| `CUBEJS_DB_TYPE` | yes | — | Must be `mongosql` for Cube to route to this driver |
| `CUBEJS_DB_URI` | yes (or HOST/USER/PASS/NAME) | — | Full MongoDB connection string |
| `CUBEJS_DB_HOST` | (legacy alt) | — | Cluster hostname |
| `CUBEJS_DB_NAME` | yes | — | Database name (where `__sql_schemas` lives if Collection mode) |
| `CUBEJS_DB_USER` / `CUBEJS_DB_PASS` | (SCRAM only) | — | SCRAM credentials |
| `CUBEJS_DB_SSL` | no | `true` | TLS (Atlas requires it) |
| `CUBEJS_MONGOSQL_SCHEMA_SOURCE` | no | `collection` | `collection` or `file` |
| `CUBEJS_MONGOSQL_SCHEMA_FILE` | (file mode) | — | Path to YAML/JSON schema file |
| `CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC` | no | `300` | Refresh interval in seconds |
| `CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN` | no | `false` | If `true`, don't fail testConnection on initial schema-load failure |
| `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` | no | `60000` | Per-query timeout |
| `CUBEJS_MONGOSQL_MAX_ROWS` | no | `100000` | Max rows returned per query (driver buffers; see NFR-1). Exceeding throws `MONGOSQL_RESULT_TOO_LARGE` |

## 4. Non-functional requirements

### NFR-1 — Performance

- **Schema cache reads**: O(1) — read lock acquisition + in-memory map lookup.
- **Hot-path translation**: `mongosql::translate_sql` measured to be sub-millisecond for typical OLAP queries; treat as effectively free.
- **Schema refresh**: must not block queries. Use Tokio's interval timer + atomic-pointer cache swap.
- **Result transport**: napi-rs has no `AsyncIterator` macro for Rust→Node, so the driver buffers query results into a `serde_json::Value::Array` before returning. To bound memory, queries are capped at `CUBEJS_MONGOSQL_MAX_ROWS` (default 100000); the driver throws `MONGOSQL_RESULT_TOO_LARGE` if exceeded. Streaming via `ThreadsafeFunction` is a post-MVP enhancement.
- **Pre-agg builds**: same row-cap applies. For partitioned pre-aggs, partition_granularity should be chosen so each partition stays under the cap. Driver-level guidance documented in README troubleshooting.

### NFR-2 — Compatibility

- **Node.js**: 18, 20, 22, 24 (Active LTS + current).
- **Cube**: `@cubejs-backend/base-driver` semver-compatible with `^1.6.0` (initial target).
- **MongoDB**: Atlas (any tier with SQL Interface available), or MongoDB Enterprise Advanced 6.0+.
- **Platforms** (prebuilt binaries): `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`. Win32 not in MVP.

### NFR-3 — Observability

- Structured logging via `tracing` crate (configurable via `RUST_LOG`).
- Metrics emitted via standard `tracing` events; consumer wires them to whatever sink they prefer (Prometheus exporter is downstream concern).
- Required log events: connection establishment, schema load, schema refresh success/failure, query translation error, query execution error.

### NFR-4 — Security

- TLS required by default (`CUBEJS_DB_SSL=true`).
- Credentials never logged.
- Schema cache contents never logged.
- AWS IAM auth: SDK chain only; never read AWS creds from env vars when Pod Identity / instance profile is available.

### NFR-5 — Test coverage targets

- Rust: ≥80% line coverage for `crates/native/src/`.
- TypeScript: ≥80% line coverage for `src/`.
- Integration: every documented SQL pattern in the README has a corresponding E2E test.

## 5. Public interfaces

### 5.1 TypeScript (`src/`)

```typescript
// src/index.ts
export { MongoSqlDriver } from './MongoSqlDriver';
export { MongoSqlQuery } from './MongoSqlQuery';
export type { MongoSqlConfig, SchemaSource } from './types';

// src/types.ts
export type SchemaSource =
  | { kind: 'collection' }
  | { kind: 'file'; path: string };

export interface MongoSqlConfig {
  uri: string;
  database: string;
  schemaSource?: SchemaSource;     // defaults to { kind: 'collection' }
  schemaRefreshSec?: number;        // defaults to 300
  schemaFailOpen?: boolean;         // defaults to false
  queryTimeoutMs?: number;          // defaults to 60000
  maxRows?: number;                 // defaults to 100000
}

// src/MongoSqlDriver.ts
export class MongoSqlDriver extends BaseDriver {
  constructor(config: MongoSqlConfig | undefined);
  // `options.signal: AbortSignal` is honoured if supplied (Cube core does
  // not pass one today; we accept it for forward compatibility and for
  // direct callers). On abort the in-flight cursor is cancelled and the
  // call rejects with `MONGOSQL_CANCELLED`.
  query<R>(sql: string, values?: unknown[], options?: { signal?: AbortSignal; [k: string]: unknown }): Promise<R[]>;
  testConnection(): Promise<void>;
  tablesSchema(): Promise<TablesSchema>;
  // `release()` also cancels any in-flight queries via a parent
  // cancellation token, then drains for up to 5s before returning. This
  // is the SIGTERM-during-pre-agg fix.
  release(): Promise<void>;
  static dialectClass(): typeof MongoSqlQuery;
}

// src/MongoSqlQuery.ts
export class MongoSqlQuery extends BaseQuery {
  // Override SQL generation methods for MongoSQL dialect
}
```

### 5.2 Rust (`crates/native/`)

The driver wraps the open-source [`mongodb/mongosql`](https://github.com/mongodb/mongosql) crate (Apache-2.0). That crate is **not published to crates.io**; it is consumed via a git source pinned to a release tag.

```toml
# Cargo.toml workspace dep — concrete tag chosen at T03 implementation
mongosql = { git = "https://github.com/mongodb/mongosql", tag = "v1.0.0-beta-1" }
```

The `mongosql` API surface we use:

| What | Symbol |
|---|---|
| Schema container | `mongosql::catalog::Catalog` |
| Build catalog from schemas | `mongosql::build_catalog_from_catalog_schema(BTreeMap<db, BTreeMap<coll, json_schema::Schema>>) -> Catalog` |
| Translate SQL → MQL | `mongosql::translate_sql(current_db: &str, sql: &str, catalog: &Catalog, options: SqlOptions) -> Result<Translation, mongosql::Error>` |
| Translation result | `Translation { target_db: String, target_collection: Option<String>, pipeline: bson::Bson, result_set_schema: ... }` |
| Discover referenced namespaces (optional) | `mongosql::get_namespaces(current_db: &str, sql: &str) -> Result<HashSet<Namespace>, _>` |

Our napi-rs surface:

```rust
// crates/native/src/lib.rs
#[napi]
pub struct MongoSqlClient { /* ... */ }

#[napi]
impl MongoSqlClient {
    #[napi(constructor)]
    pub fn new(config: ClientConfig) -> napi::Result<Self>;

    #[napi]
    pub async fn test_connection(&self, signal: Option<&AbortHandle>) -> napi::Result<()>;

    /// Returns rows as JSON array (BSON values → JSON values).
    /// Buffered up to ClientConfig.max_rows; exceeds throw RESULT_TOO_LARGE.
    /// Optional `signal` cancels the in-flight cursor with
    /// `MONGOSQL_CANCELLED`. `close()` also cancels via a parent token.
    #[napi]
    pub async fn query(
        &self,
        sql: String,
        signal: Option<&AbortHandle>,
    ) -> napi::Result<serde_json::Value>;

    /// Returns Cube's expected table-introspection structure.
    #[napi]
    pub async fn tables_schema(
        &self,
        signal: Option<&AbortHandle>,
    ) -> napi::Result<serde_json::Value>;

    /// Closes underlying connections, cancels in-flight queries via the
    /// parent cancellation token, and waits up to 5s for them to drain.
    #[napi]
    pub async fn close(&self) -> napi::Result<()>;
}

/// Opaque cancellation handle. JS bridges its own `AbortSignal` to this
/// by registering a listener that calls `handle.abort()`. The driver's
/// TypeScript wrapper (`src/native.ts`) does the bridging automatically;
/// direct Rust callers may use this type directly.
#[napi]
pub struct AbortHandle { /* ... */ }

#[napi]
impl AbortHandle {
    #[napi(constructor)]
    pub fn new() -> Self;

    /// Mark this handle aborted. Idempotent.
    #[napi]
    pub fn abort(&self);

    /// Synchronous probe.
    #[napi]
    pub fn aborted(&self) -> bool;
}

#[napi(object)]
pub struct ClientConfig {
    pub uri: String,
    pub database: String,
    pub schema_source: SchemaSource,
    pub schema_refresh_sec: u32,
    pub schema_fail_open: bool,
    pub query_timeout_ms: u32,
    pub max_rows: u32,
}
```

### 5.3 Schema document format

Compatible with `__sql_schemas` documents (which are JSON Schema):

```yaml
# Example: tests/integration/fixtures/mongo-schema.yaml
schema:
  version: 1
  jsonSchema:
    bsonType: object
    properties:
      orders:
        bsonType: object
        properties:
          _id:        { bsonType: objectId }
          account_id: { bsonType: string }
          amount:     { bsonType: decimal }
          status:     { bsonType: string }
          created_at: { bsonType: date }
      users:
        bsonType: object
        properties:
          _id:    { bsonType: objectId }
          email:  { bsonType: string }
          name:   { bsonType: string }
```

## 6. Error contracts

All driver errors thrown to Cube MUST be `Error` instances with `name` and `message`. Where applicable, attach `code` for programmatic handling:

| Error code | Cause | Recovery |
|---|---|---|
| `MONGOSQL_CONFIG_INVALID` | Missing required env var or bad config shape | Fix config; restart |
| `MONGOSQL_CONNECT_FAILED` | Cannot reach MongoDB | Check network, credentials, TLS |
| `MONGOSQL_AUTH_FAILED` | Auth handshake failed | Check credentials / IAM role |
| `MONGOSQL_SCHEMA_NOT_FOUND` | `__sql_schemas` empty or missing | Enable Atlas SQL sampling, run Schema Builder, or provide file |
| `MONGOSQL_SCHEMA_INVALID` | Schema document fails parsing | Fix schema source format |
| `MONGOSQL_SCHEMA_FILE_NOT_FOUND` | File mode: file missing | Check `CUBEJS_MONGOSQL_SCHEMA_FILE` |
| `MONGOSQL_TRANSLATE_FAILED` | `mongosql::translate` rejected SQL | Check column names, types vs schema |
| `MONGOSQL_EXECUTE_FAILED` | Aggregation pipeline failed at MongoDB | Check Mongo logs; reproduce with `mongosql-cli` |
| `MONGOSQL_TIMEOUT` | Query exceeded `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` | Add pre-agg, optimize query, increase timeout |
| `MONGOSQL_RESULT_TOO_LARGE` | Cursor returned more rows than `CUBEJS_MONGOSQL_MAX_ROWS` | Add pre-agg, narrow filter, raise cap |
| `MONGOSQL_CANCELLED` | Caller fired an `AbortSignal`, or `release()` cancelled the in-flight query | Expected on shutdown / user-cancel — no retry needed |

## 7. Out of scope (deferred)

- Win32 platform support
- Self-managed schema sampler (we expect Atlas or EA Schema Builder to populate `__sql_schemas`)
- Custom auth plugins
- Multi-database queries within one driver instance (per-tenant scoping uses one DB per driver)
- Cube `EXPORT_BUCKET` semantics
- Sharded cluster topologies beyond what the upstream `mongodb` Rust driver supports

## 8. Open questions

- **`mongosql` crate license**: must be Apache-2.0 / MIT / BSD-equivalent for npm distribution. **If SSPL or any copyleft variant: STOP and seek legal review.** Resolved by IMPLEMENTATION_PLAN.md T00.
- **`mongosql` crate availability and public API**: not yet verified that it's usable from outside MongoDB's own JDBC driver context. Type names used in this spec (`MongoSqlCatalog`, `Translation`) are working names that may be revised after T00.
- **napi-rs / mongodb-crate Tokio compatibility**: must be verified by hello-world, not assumed. T00.
- **Streaming vs buffering**: SPEC NFR-1 promises "cursor-based streaming, bounded memory" but §5.2 returns `serde_json::Value` (buffered). Either replace with napi-rs `AsyncIterator` semantics OR honestly bound max result size. Decide in T00.
- **Type-conversion table** for BSON → JSON: see ARCHITECTURE.md §4.2; extend with `MinKey`/`MaxKey`/`Undefined` once T00 verifies the upstream BSON crate's exposed type list.
- **MongoSQL dialect** completeness: which exact `BaseQuery` method overrides are needed? Pre-enumerated as a pre-task step in T11/T12a.
- ~~**Cancellation propagation**: not yet wired — Cube's `AbortSignal` ↔ Tokio `CancellationToken`. Currently relies on `max_time`.~~ **Resolved 2026-05-10**: implemented via a hand-rolled `CancelToken` (`AtomicBool` + `tokio::sync::Notify`) bridged to JS via the napi-rs `AbortHandle` class — napi-rs 2.16's first-class `AbortSignal` is `AsyncTask`-only and incompatible with `#[napi] async fn`. `release()` cancels in-flight queries via a parent token with a 5s drain budget. See IMPLEMENTATION_PLAN.md *Discoveries* (2026-05-10 — cancellation).
- **napi-rs version pin**: target latest stable `napi@2` and pin a specific minor.
- **`mongosql` crate version**: pin to a specific release; track upstream for compatibility.

## 9. References

- [Cube CONTRIBUTING — Database drivers](https://github.com/cube-js/cube/blob/master/CONTRIBUTING.md#contributing-database-drivers)
- [`@cubejs-backend/base-driver`](https://github.com/cube-js/cube/tree/master/packages/cubejs-base-driver)
- [`@cubejs-backend/schema-compiler/adapter`](https://github.com/cube-js/cube/tree/master/packages/cubejs-schema-compiler/src/adapter) (BaseQuery subclasses to fork)
- [`mongodb/mongosql`](https://github.com/mongodb/mongosql)
- [`mongodb` Rust crate](https://docs.rs/mongodb/)
- [napi-rs](https://napi.rs)
- [MongoSQL Language Reference](https://www.mongodb.com/docs/sql-interface/language-reference/)
- [BI Connector EOL notice](https://www.mongodb.com/docs/atlas/bi-connection/)

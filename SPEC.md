# `cubejs-mongosql-driver` — Specification

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

- Translate every SQL query through `mongosql::translate(sql, schema)` using the cached schema.
- Send the resulting MQL pipeline to MongoDB via `db.<collection>.aggregate(pipeline)` semantics through the official `mongodb` Rust crate.
- Stream results using cursors (no full-result-set buffering for large queries).
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

## 4. Non-functional requirements

### NFR-1 — Performance

- **Schema cache reads**: O(1) — read lock acquisition + in-memory map lookup.
- **Hot-path translation**: `mongosql::translate` measured to be sub-millisecond for typical OLAP queries; treat as effectively free.
- **Schema refresh**: must not block queries. Use Tokio's interval timer + atomic-pointer cache swap.
- **Pre-agg builds**: cursor-based streaming; bounded memory regardless of result set size.

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
}

// src/MongoSqlDriver.ts
export class MongoSqlDriver extends BaseDriver {
  constructor(config: MongoSqlConfig | undefined);
  query<R>(sql: string, values?: unknown[]): Promise<R[]>;
  testConnection(): Promise<void>;
  tablesSchema(): Promise<TablesSchema>;
  release(): Promise<void>;
  static dialectClass(): typeof MongoSqlQuery;
}

// src/MongoSqlQuery.ts
export class MongoSqlQuery extends BaseQuery {
  // Override SQL generation methods for MongoSQL dialect
}
```

### 5.2 Rust (`crates/native/`)

```rust
// crates/native/src/lib.rs
#[napi]
pub struct MongoSqlClient { /* ... */ }

#[napi]
impl MongoSqlClient {
    #[napi(constructor)]
    pub fn new(config: ClientConfig) -> napi::Result<Self>;

    #[napi]
    pub async fn test_connection(&self) -> napi::Result<()>;

    /// Returns rows as JSON array (BSON values → JSON values).
    #[napi]
    pub async fn query(&self, sql: String) -> napi::Result<serde_json::Value>;

    /// Returns Cube's expected table-introspection structure.
    #[napi]
    pub async fn tables_schema(&self) -> napi::Result<serde_json::Value>;

    #[napi]
    pub async fn close(&self) -> napi::Result<()>;
}

#[napi(object)]
pub struct ClientConfig {
    pub uri: String,
    pub database: String,
    pub schema_source: SchemaSource,
    pub schema_refresh_sec: u32,
    pub schema_fail_open: bool,
    pub query_timeout_ms: u32,
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

## 7. Out of scope (deferred)

- Win32 platform support
- Self-managed schema sampler (we expect Atlas or EA Schema Builder to populate `__sql_schemas`)
- Custom auth plugins
- Multi-database queries within one driver instance (per-tenant scoping uses one DB per driver)
- Cube `EXPORT_BUCKET` semantics
- Sharded cluster topologies beyond what the upstream `mongodb` Rust driver supports

## 8. Open questions

- **Type-conversion table** for BSON → JSON: ObjectId as string? Decimal128 as string vs number? Need explicit table — defer to ARCHITECTURE.md §5.
- **MongoSQL dialect** completeness: which exact `BaseQuery` method overrides are needed? Spike in Phase 3 of IMPLEMENTATION_PLAN.md.
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

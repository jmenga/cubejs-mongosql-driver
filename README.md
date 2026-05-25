# mongosql-cubejs-driver

[![ci](https://github.com/jmenga/cubejs-mongosql-driver/actions/workflows/ci.yaml/badge.svg)](https://github.com/jmenga/cubejs-mongosql-driver/actions/workflows/ci.yaml)
[![e2e](https://github.com/jmenga/cubejs-mongosql-driver/actions/workflows/e2e.yaml/badge.svg)](https://github.com/jmenga/cubejs-mongosql-driver/actions/workflows/e2e.yaml)
[![npm version](https://img.shields.io/npm/v/mongosql-cubejs-driver.svg)](https://www.npmjs.com/package/mongosql-cubejs-driver)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A native [Cube.js](https://cube.dev) data source driver for MongoDB. Translates SQL to MongoDB Aggregation Pipeline (MQL) **client-side** via the open-source [`mongosql`](https://github.com/mongodb/mongosql) Rust crate, then executes the pipeline directly against your MongoDB cluster over the standard wire protocol on port 27017. No JDBC, no JVM, no `mongosqld` — and a drop-in replacement for the EOL'd MongoDB BI Connector path (`@cubejs-backend/mongobi-driver`).

## Status

> **Pre-alpha (0.1.0).** Functional end-to-end against [`mongodb-atlas-local`](https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-local/); not yet validated against production Atlas at scale. Track progress in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Why this exists

The MongoDB BI Connector (`mongosqld`) reaches end-of-life on **30 September 2026** for both Atlas and on-premises deployments. Cube's official MongoDB path (`@cubejs-backend/mongobi-driver`) depends on it. This driver replaces that path with a direct, native, BI-Connector-free implementation that:

- Runs in the Cube process (no proxy, no Federation routing, no extra wire hops).
- Talks the MongoDB wire protocol directly to your cluster — same TLS, same auth, same port.
- Carries the SQL→MQL translator in-tree as a Rust dependency, so you ship one Node addon, not a Java service.

## How it works

```
┌─────────────── cube container (cubejs/cube:v1.6.x) ─────────────────┐
│                                                                     │
│   Node.js process                                                   │
│      Cube engine                                                    │
│           │ SQL                                                     │
│           ▼                                                         │
│      mongosql-cubejs-driver (this package)                          │
│        ├─ MongoSqlDriver  (extends BaseDriver)                      │
│        └─ MongoSqlQuery   (extends BaseQuery — dialect)             │
│                  │                                                  │
│   ═══════════════│════════ napi-rs FFI (in-process) ═══════════     │
│                  ▼                                                  │
│   Rust .node module (crates/native)                                 │
│      ┌─ schema cache ────┐  ◄── refresh task (300s)                 │
│      │ Arc<RwLock>       │                                          │
│      └──────┬────────────┘                                          │
│             ▼                                                       │
│      mongosql crate ── MQL ──┐                                      │
│                              ▼                                      │
│      mongodb crate (official) ────────────────────────────────────► │
└─────────────────────────────────────────────────────────────────────┘
                                                          │
                                              MongoDB wire · TLS · :27017
                                                          ▼
                                       ┌── MongoDB cluster ──┐
                                       │  application data   │
                                       │  __sql_schemas      │
                                       └─────────────────────┘
```

The Rust shim caches schema in memory, refreshes it every 5 minutes in the background, and translates per-query in microseconds. Full diagram and module map: [ARCHITECTURE.md](./ARCHITECTURE.md).

## What this is and isn't

**Is:**

- A Cube.js driver — install via npm, configure via `CUBEJS_DB_TYPE=mongosql`.
- Native: Rust + napi-rs, distributed as prebuilt binaries.
- Direct to MongoDB: no proxy process, no Federation routing.

**Isn't:**

- Not a JDBC bridge.
- Not a CDC-to-warehouse pipeline.
- Not a schema sampler — schema population is up to your deployment (Atlas SQL Interface, EA Schema Builder CLI, or a YAML/JSON file you maintain).

## Install

### Quick start (Docker)

The fastest way to try the driver end-to-end is the Docker example, which spins up `mongodb-atlas-local` + a Cube image with the driver baked in:

```bash
git clone https://github.com/jmenga/cubejs-mongosql-driver.git
cd cubejs-mongosql-driver
examples/docker/build-driver.sh                                  # produces examples/docker/pkg/*.tgz
docker compose -f examples/docker/docker-compose.yaml build
docker compose -f examples/docker/docker-compose.yaml up -d
open http://localhost:4000                                       # Cube playground
```

See [examples/docker/README.md](./examples/docker/README.md) for what each piece does and how to extend it.

### Manual (existing Cube install)

```bash
npm install mongosql-cubejs-driver
# or
pnpm add mongosql-cubejs-driver
```

Cube auto-resolves `CUBEJS_DB_TYPE=mongosql` to this package via Cube's [`${type}-cubejs-driver` community-driver convention](https://cube.dev/docs/config/databases#community-supported-drivers) — no `driverFactory` override required for the lookup to succeed. (You may still want one if you're wiring the dialect class explicitly; see [`examples/docker/cube/cube.js`](./examples/docker/cube/cube.js).)

If you're using a Docker-based Cube deployment, see [`examples/docker/Dockerfile`](./examples/docker/Dockerfile) for the install pattern (the Cube official image expects packages at `/cube/conf/node_modules`).

### Platform support

The package ships a small JavaScript loader plus per-platform prebuilt native binaries published as separate npm sub-packages. The root package declares each platform binary as `optionalDependencies`; npm uses your runtime's `os`, `cpu`, and `libc` to install only the matching binary. **No local Rust toolchain is required for end users.**

| Platform                    | Sub-package                               | Prebuilt?  |
| --------------------------- | ----------------------------------------- | ---------- |
| Linux x64 (glibc)           | `mongosql-cubejs-driver-linux-x64-gnu`    | yes        |
| Linux arm64 (glibc)         | `mongosql-cubejs-driver-linux-arm64-gnu`  | yes        |
| Linux x64 (musl)            | `mongosql-cubejs-driver-linux-x64-musl`   | yes        |
| Linux arm64 (musl)          | `mongosql-cubejs-driver-linux-arm64-musl` | yes        |
| macOS x64 (Intel)           | `mongosql-cubejs-driver-darwin-x64`       | yes        |
| macOS arm64 (Apple Silicon) | `mongosql-cubejs-driver-darwin-arm64`     | yes        |
| Windows (`win32`)           | —                                         | not in MVP |

If `npm install` cannot find a matching binary it will fail with a clear "no native binary for your platform" error from the loader.

## Configure

All configuration is via standard Cube env vars where they exist; new `CUBEJS_MONGOSQL_*` vars where they don't. Where both a Cube-standard `CUBEJS_DB_*` and a driver-specific `CUBEJS_MONGOSQL_*` exist for the same setting, the Cube-standard var wins.

### Connection identity (one of)

You must give the driver enough information to build a MongoDB connection string. The precedence order (highest → lowest) is:

1. Constructor `uri` arg (only relevant when embedding the driver programmatically)
2. `CUBEJS_DB_URL`
3. `CUBEJS_DB_URI`
4. Composed from `CUBEJS_DB_HOST` (+ optional `_PORT`, `_USER`, `_PASS`, `_NAME`)

| Env var          | Required?    | Default | Purpose                                                                 |
| ---------------- | ------------ | ------- | ----------------------------------------------------------------------- |
| `CUBEJS_DB_TYPE` | yes          | —       | Must be `mongosql` for Cube to route to this driver                     |
| `CUBEJS_DB_URL`  | one of these | —       | Full MongoDB connection string (`mongodb://…` or `mongodb+srv://…`)     |
| `CUBEJS_DB_URI`  | one of these | —       | Alias for `CUBEJS_DB_URL` (legacy; `_URL` wins if both set)             |
| `CUBEJS_DB_HOST` | one of these | —       | Single host, or comma-separated seed list (`host1:27017,host2:27017`)   |
| `CUBEJS_DB_PORT` | no           | —       | Port; appended only when `CUBEJS_DB_HOST` is a single host with no port |
| `CUBEJS_DB_USER` | no           | —       | SCRAM username (URL-encoded into the composed URI)                      |
| `CUBEJS_DB_PASS` | no           | —       | SCRAM password (URL-encoded; requires `CUBEJS_DB_USER`)                 |
| `CUBEJS_DB_NAME` | yes          | —       | Database name (where `__sql_schemas` lives in collection mode)          |

### Connection tuning (env-driven URI params)

These set MongoDB connection-string parameters on the URI handed to the [`mongodb`](https://crates.io/crates/mongodb) Rust crate. Any value the user already specifies inside `CUBEJS_DB_URL` / `CUBEJS_DB_URI` wins — env-driven values only fill in keys the URI hasn't set.

| Env var                                       | Default      | URI param                  | Purpose                                                                                                             |
| --------------------------------------------- | ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `CUBEJS_DB_SSL`                               | mongo crate  | `tls`                      | Enable TLS (`true` / `1` → `tls=true`; Atlas connections already enable it by default)                              |
| `CUBEJS_DB_MAX_POOL`                          | mongo crate  | `maxPoolSize`              | Maximum concurrent connections in the pool                                                                          |
| `CUBEJS_DB_MIN_POOL`                          | `0`          | `minPoolSize`              | Minimum connections held warm in the pool                                                                           |
| `CUBEJS_DB_IDLE_TIMEOUT`                      | mongo crate  | `maxIdleTimeMS`            | Close idle connections after this long. Accepts ms (`60000`), `ms`/`s`/`m`/`h` suffix (`60s`, `5m`, `1h`)           |
| `CUBEJS_MONGOSQL_MAX_CONNECTING`              | mongo crate  | `maxConnecting`            | Max concurrent in-flight pool establishment operations                                                              |
| `CUBEJS_MONGOSQL_WAIT_QUEUE_TIMEOUT_MS`       | mongo crate  | `waitQueueTimeoutMS`       | How long a checkout call waits for a free connection                                                                |
| `CUBEJS_MONGOSQL_CONNECT_TIMEOUT_MS`          | mongo crate  | `connectTimeoutMS`         | TCP/TLS connect timeout                                                                                             |
| `CUBEJS_MONGOSQL_SOCKET_TIMEOUT_MS`           | mongo crate  | `socketTimeoutMS`          | Per-socket I/O timeout                                                                                              |
| `CUBEJS_MONGOSQL_SERVER_SELECTION_TIMEOUT_MS` | mongo crate  | `serverSelectionTimeoutMS` | How long to wait for a suitable server in the topology                                                              |
| `CUBEJS_MONGOSQL_HEARTBEAT_FREQUENCY_MS`      | mongo crate  | `heartbeatFrequencyMS`     | SDAM heartbeat cadence                                                                                              |
| `CUBEJS_MONGOSQL_APP_NAME`                    | —            | `appName`                  | Tag connections so MongoDB ops/logs identify the Cube driver (`$currentOp.appName`, `serverStatus().connections`)   |
| `CUBEJS_MONGOSQL_RETRY_WRITES`                | mongo crate  | `retryWrites`              | Retry retryable write commands                                                                                      |
| `CUBEJS_MONGOSQL_RETRY_READS`                 | mongo crate  | `retryReads`               | Retry retryable read commands                                                                                       |
| `CUBEJS_MONGOSQL_COMPRESSORS`                 | —            | `compressors`              | Wire-protocol compressors (e.g. `snappy,zstd`)                                                                      |

### Driver-internal knobs

These are not URI params — they control the driver layer itself.

| Env var                              | Required?            | Default      | Purpose                                                                                                                       |
| ------------------------------------ | -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `CUBEJS_DB_QUERY_TIMEOUT`            | no                   | `10m`        | Per-query timeout (drives the aggregation pipeline's `maxTimeMS`). Accepts duration strings or bare ms; wins over the legacy var below |
| `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS`   | no                   | `60000`      | Legacy bare-ms timeout; still honoured when `CUBEJS_DB_QUERY_TIMEOUT` is unset                                                |
| `CUBEJS_MONGOSQL_SCHEMA_SOURCE`      | no                   | `collection` | `collection`, `file`, or `atlas-sql` (required for Atlas SQL endpoints — see [Schema management](#schema-management))         |
| `CUBEJS_MONGOSQL_SCHEMA_FILE`        | yes if `SOURCE=file` | —            | Path to YAML/JSON schema file                                                                                                 |
| `CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC` | no                   | `300`        | Background schema-refresh interval in seconds                                                                                 |
| `CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN`   | no                   | `false`      | If `true`, `testConnection()` does not fail on initial schema-load failure (cache stays empty until next refresh)             |
| `CUBEJS_MONGOSQL_MAX_ROWS`           | no                   | `100000`     | Max rows returned per query; exceeding throws `MONGOSQL_RESULT_TOO_LARGE` (see [Pre-aggregations](#pre-aggregations))         |

> **Tip:** if you already encode parameters into `CUBEJS_DB_URL` / `CUBEJS_DB_URI` (e.g. `?maxPoolSize=20&tls=true`), those values always win — env-driven settings only fill in keys the URI hasn't specified. Cube docs source: <https://cube.dev/docs/product/configuration/reference/environment-variables>.

### Connection examples

#### Atlas + SCRAM (username/password)

```bash
CUBEJS_DB_TYPE=mongosql
CUBEJS_DB_URI='mongodb+srv://cube_reader:REPLACE_ME@cluster.mongodb.net/?retryWrites=true&w=majority&authSource=admin'
CUBEJS_DB_NAME=example
```

#### Atlas + AWS IAM (EKS Pod Identity)

```bash
CUBEJS_DB_TYPE=mongosql
CUBEJS_DB_URI='mongodb+srv://cluster.mongodb.net/?authMechanism=MONGODB-AWS&authSource=$external'
CUBEJS_DB_NAME=example
```

AWS credentials are picked up automatically from the Pod Identity / instance-profile chain by the underlying [`mongodb` Rust crate](https://docs.rs/mongodb/) — never put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in your env if you can avoid it. See [`examples/atlas-prod/`](./examples/atlas-prod/) for a full Cube + EKS setup.

#### Self-hosted MongoDB Enterprise Advanced

```bash
CUBEJS_DB_TYPE=mongosql
CUBEJS_DB_URI='mongodb://cube_reader:REPLACE_ME@mongo-1.internal:27017,mongo-2.internal:27017,mongo-3.internal:27017/?replicaSet=rs0&tls=true&authSource=admin'
CUBEJS_DB_NAME=example
```

EA does not auto-populate `__sql_schemas`. Run the [Schema Builder CLI](https://www.mongodb.com/docs/atlas/data-federation/query/sql/schema-management/) once per database to seed it, or use file mode (below) for schema-as-code.

#### Local development with `mongodb-atlas-local`

```bash
CUBEJS_DB_TYPE=mongosql
CUBEJS_DB_URI='mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true'
CUBEJS_DB_NAME=mongosql_test
CUBEJS_MONGOSQL_SCHEMA_SOURCE=file
CUBEJS_MONGOSQL_SCHEMA_FILE=/path/to/mongo-schema.yaml
```

`directConnection=true` is required for atlas-local because it advertises an unresolvable internal hostname when SDAM tries to walk the replica set. See [`examples/local-dev/`](./examples/local-dev/) for a docker-compose-driven loop.

## Schema management

`mongosql` translates SQL by consulting a JSON-Schema-shaped catalog of your collections. The driver loads that catalog from one of three sources, selected by `CUBEJS_MONGOSQL_SCHEMA_SOURCE`:

| Mode                   | Source                                                      | Use case                                                                                                |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `collection` (default) | `__sql_schemas` collection in `CUBEJS_DB_NAME`              | Production (Atlas SQL Interface or EA Schema Builder maintain it)                                       |
| `file`                 | YAML or JSON file at `CUBEJS_MONGOSQL_SCHEMA_FILE`          | Local dev, schema-as-code, EA without Schema Builder, edge cases                                        |
| `atlas-sql`            | `sqlGetSchema` admin command per collection in the database | Atlas SQL endpoints (`*.a.query.mongodb.net`) — schemas live in an internal store, not as a collection  |

The driver loads schema once on `testConnection()` (fail-closed by default; toggle with `CUBEJS_MONGOSQL_SCHEMA_FAIL_OPEN=true`), caches it under an `Arc<RwLock<Catalog>>`, refreshes it every `CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC` seconds, and atomically swaps cache contents on each successful refresh. Refresh failures log a warning and keep serving cached schema; queries never block on schema I/O.

### Collection mode (default — recommended for Atlas)

Atlas's SQL Interface samples your collections every few hours and writes the schema to `__sql_schemas` in each database. To enable it:

1. In the Atlas UI, navigate to your cluster → **Services** → **Atlas SQL** → enable.
2. Wait for the first sample to land (a few minutes for small clusters).
3. Confirm: in `mongosh`, `db.getCollection('__sql_schemas').countDocuments()` should be > 0.
4. Set `CUBEJS_MONGOSQL_SCHEMA_SOURCE=collection` (or omit — it's the default).

For MongoDB Enterprise Advanced, run the [`mongosql-schema-builder` CLI](https://www.mongodb.com/docs/atlas/data-federation/query/sql/schema-management/#use-the-mongodb-schema-builder-cli) once per database to populate `__sql_schemas`; subsequent edits are manual or scripted.

### File mode

When `CUBEJS_MONGOSQL_SCHEMA_SOURCE=file`, the driver reads a YAML or JSON document with a single top-level `schema` field:

```yaml
# schema.yaml
schema:
  version: 1
  jsonSchema:
    bsonType: object
    properties:
      orders:
        bsonType: object
        properties:
          _id: { bsonType: objectId }
          account_id: { bsonType: string }
          amount: { bsonType: decimal }
          status: { bsonType: string }
          created_at: { bsonType: date }
      users:
        bsonType: object
        properties:
          _id: { bsonType: objectId }
          email: { bsonType: string }
          name: { bsonType: string }
```

> **Limitation (T05/T09 discovery):** file-mode envelopes carry no database name. Internally the loader keys collections under an empty-string placeholder; the napi surface re-keys translation results to `CUBEJS_DB_NAME` so the executor targets the right database. The user-visible behaviour is identical to collection mode — but if you're authoring tooling that introspects the catalog, be aware of the asymmetry. See [`examples/local-dev/`](./examples/local-dev/) for a working file-mode setup.

### Atlas SQL mode (required for `*.a.query.mongodb.net` endpoints)

Atlas SQL endpoints — the dedicated SQL fronts Atlas provisions for the SQL Interface, with hostnames of the form `<cluster>-<id>.a.query.mongodb.net` — do NOT expose `__sql_schemas` as a queryable collection. Schemas live in an internal store and are reachable only via the `sqlGetSchema` admin-style command. Collection-mode discovery fails on these endpoints because the document `db.<dbname>.__sql_schemas.find()` returns nothing even though the schemas exist.

Set `CUBEJS_MONGOSQL_SCHEMA_SOURCE=atlas-sql` for these endpoints:

```bash
CUBEJS_DB_TYPE=mongosql
CUBEJS_DB_URI='mongodb://USER:PASS@atlas-sql-685d57005fe09d047b8f2d31-zlj67.a.query.mongodb.net/?ssl=true&authSource=admin&appName=cube'
CUBEJS_DB_NAME=dev-convo-hub
CUBEJS_MONGOSQL_SCHEMA_SOURCE=atlas-sql
```

In this mode the driver:

1. Calls `listCollections` on `CUBEJS_DB_NAME` to enumerate candidate collections.
2. Filters out `system.*` collections and `__sql_schemas`.
3. Runs `sqlGetSchema` per remaining collection with **bounded parallelism** (up to 8 in flight at once — see `ATLAS_SQL_FAN_OUT_CONCURRENCY` in `crates/native/src/schema.rs`). Empty-schema responses (`{ok: 1, metadata: {}, schema: {}}`) — the canonical "no schema set for this name" shape — are SKIPPED, not errored. Populated responses (`{ok: 1, metadata: {description}, schema: {version, jsonSchema}}`) are added to the catalog. The parallel fan-out turns an `N × RTT` refresh into roughly `ceil(N / 8) × RTT`, which matters on databases with 100+ collections.
4. Re-runs the same enumeration on the `CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC` cadence (default 300 s) so Atlas-driven schema updates surface without a driver restart.

Canonical command spec: <https://www.mongodb.com/docs/sql-interface/schema/view/>. There is no `sqlListSchemas` command — enumeration is `listCollections` + per-collection `sqlGetSchema`, which is what the driver does.

#### Required Atlas role grants

`sqlGetSchema` is an admin-style command. The connecting user MUST hold either:

- the built-in `atlasAdmin` role on the Atlas project, OR
- a database-user role combination granting `clusterMonitor` (on `admin`) plus `readAnyDatabase` (on `admin`).

A user who can authenticate and `listCollections` but lacks `sqlGetSchema` privileges will surface a MongoDB error with code **13 (`Unauthorized`)**. The driver detects this and raises `MONGOSQL_SCHEMA_INVALID` with a hint that embeds the required role names directly (no documentation-traversal needed) and points at the Atlas "Configure Database Users" page where the operator actually performs the fix: <https://www.mongodb.com/docs/atlas/security-add-mongodb-users/> (Atlas UI: Project → Security → Database Access → Edit user).

> **Why this URL?** MongoDB's docs do not publish a single deep-linkable page that says "these are the roles `sqlGetSchema` requires" — the privilege table lives in the dynamically-rendered built-in-roles reference which is unstable to deep-link. The role names are therefore embedded directly in the error message; the URL is the operator-facing landing page for the actual fix.

If `sqlGetSchema` fails with code **59 (`CommandNotFound`)** the endpoint isn't an Atlas SQL endpoint at all (the typical "I'm pointing atlas-sql mode at a regular cluster" misconfiguration). The driver surfaces a distinct hint suggesting collection mode for that case. Any other failure is reported with the underlying message routed through the credential-redactor so connection strings don't leak.

## Pre-aggregations

Cube pre-aggregations work with the driver:

- Partitioned pre-aggs (`partition_granularity`)
- Incremental refresh (`incremental: true` + `update_window`)
- Time-based and SQL-based refresh keys
- Build-range (`build_range_start` / `build_range_end`)

**`CUBEJS_DB_EXPORT_BUCKET` is NOT supported** (MongoDB has no `UNLOAD`/`COPY TO` equivalent). Pre-agg builds stream through the driver to Cube Store row-by-row.

### Partitioning around the row cap

Each partition build is one driver query and is bounded by `CUBEJS_MONGOSQL_MAX_ROWS` (default 100 000). Pick a `partition_granularity` so each partition's row count stays under the cap. Rough heuristics:

| Daily volume    | Suggested `partition_granularity` |
| --------------- | --------------------------------- |
| < 100k rows/day | `month`                           |
| ~ 1M rows/day   | `week`                            |
| ~ 10M rows/day  | `day`                             |
| > 10M rows/day  | `hour`, or pre-filter by tenant   |

If you hit `MONGOSQL_RESULT_TOO_LARGE` during a build, narrow the partition (or raise the cap; see [Troubleshooting](#mongosql_result_too_large)).

## Authentication

The driver supports every MongoDB auth mechanism supported by the official [`mongodb` Rust crate](https://docs.rs/mongodb/), since auth is delegated to the upstream driver. Documented and tested:

| Mechanism       | URI sample                                                                                | Notes                                                                             |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SCRAM-SHA-256` | `mongodb+srv://user:pass@cluster.mongodb.net/?authSource=admin`                           | Atlas default. Username/password.                                                 |
| `MONGODB-AWS`   | `mongodb+srv://cluster.mongodb.net/?authMechanism=MONGODB-AWS&authSource=$external`       | AWS IAM. Pod Identity / instance profile / env-var chain. **Recommended on EKS.** |
| `MONGODB-X509`  | `mongodb+srv://cluster.mongodb.net/?authMechanism=MONGODB-X509&tlsCertificateKeyFile=...` | Certificate-based. Cert + key path encoded in URI; must be PEM bundle.            |

OIDC and Kerberos are inherited from the upstream driver but not first-class targets in v0.1.0.

## Type handling

| BSON type                                                                  | JSON representation                  | Notes                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `Decimal128`                                                               | string (e.g. `"4521.50"`)            | Preserves precision and scale; convert with `Number(...)` or `decimal.js`. See below.                                       |
| `ObjectId`                                                                 | 24-char hex string                   | Same wire form Atlas BI Connector emitted.                                                                                  |
| `Date` (BSON datetime)                                                     | ISO 8601 / RFC 3339 string           | E.g. `"2026-04-01T10:00:00Z"`. Out-of-range dates fall back to canonical EJSON `{"$date": {"$numberLong": "..."}}`.         |
| `int32` / `int64`                                                          | JSON number                          | i64 values outside the JS safe-integer range round-trip safely as numbers up to 2^53−1; beyond that, prefer string columns. |
| `double`                                                                   | JSON number                          | IEEE-754 double, no transformation.                                                                                         |
| `bool`                                                                     | JSON `true`/`false`                  | —                                                                                                                           |
| `string`                                                                   | JSON string                          | —                                                                                                                           |
| `array`                                                                    | JSON array                           | Element conversion is recursive.                                                                                            |
| `embedded document`                                                        | JSON object                          | Recursive.                                                                                                                  |
| `Binary`, `Symbol`, `Regex`, `Javascript`, `MinKey`, `MaxKey`, `DbPointer` | canonical EJSON (`{"$<type>": ...}`) | Round-trippable; cast to `string` in dialect.                                                                               |
| `Null` / `Undefined`                                                       | JSON `null`                          | Distinguished only via `tablesSchema()` typing.                                                                             |

### Decimal128 returns as strings — by design

A JS `Number` (IEEE 754 double) can only represent ~15–17 significant decimal digits, while `Decimal128` carries up to 34 and a fixed scale. Returning a number would silently lose precision past the double-safe range AND would drop the input quantum (e.g. `"4521.50"` would become `4521.5`, losing the cents-scale digit — a real problem for accounting balances).

Convert only after deciding your precision strategy:

```ts
// Display-only (precision loss acceptable):
const n = Number(row.amount); // "4521.50" → 4521.5

// Preserve scale, do arithmetic in fixed-point (recommended for money):
import Decimal from 'decimal.js';
const d = new Decimal(row.amount); // exact

// Server-side aggregation (no JS arithmetic at all):
//   SELECT SUM(amount) FROM orders ...  ← MongoSQL keeps Decimal128 throughout.
```

The string form is the canonical IEEE 754-2008 representation produced by `bson::Decimal128::to_string`.

### Row-shape contract — every row has the same keys

The driver guarantees that every row returned from `query()` and `downloadQueryResults()` carries the SAME key set — no row is sparser than any other. Missing values are returned as JSON `null` rather than as a missing key.

Why this matters: mongosql's `$project` of a nested-path expression (e.g. `agent.displayName`) OMITS the field from the output row when the source document doesn't carry that path — it does not emit `null`. With a query that `ORDER BY <nested-field> ASC`, the rows missing the field sort to the top of the result, so the row at index 0 is sparse. Downstream consumers (notably Cube's native `getFinalQueryResult` transform in `@cubejs-backend/native`) compile their row→member extraction plan from the keys present in row 0, and a sparse row 0 causes Cube to drop the column from every row in the response. The driver normalizes the row shape (union of keys across all rows on the `/load` path; authoritative type list from `mongosql::Translation::select_order` on the pre-aggregation upload path) so the column survives.

If you query the driver directly, you can rely on `row.<column>` returning either the value or `null` — never `undefined`-from-missing-key.

## Errors

All driver errors thrown to Cube are `Error` instances with `name = 'MongoSqlError'` and a `code` for programmatic handling:

| Error code                       | Cause                                                     | Recovery                                                                 |
| -------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `MONGOSQL_CONFIG_INVALID`        | Missing required env var or bad config shape              | Fix config; restart                                                      |
| `MONGOSQL_CONNECT_FAILED`        | Cannot reach MongoDB                                      | Check network, URI, TLS, IP allowlist                                    |
| `MONGOSQL_AUTH_FAILED`           | Auth handshake failed                                     | Check credentials / IAM role / `authSource`                              |
| `MONGOSQL_SCHEMA_NOT_FOUND`      | `__sql_schemas` empty or missing                          | Enable Atlas SQL Interface, run Schema Builder, or switch to `file` mode |
| `MONGOSQL_SCHEMA_INVALID`        | Schema document fails parsing                             | Fix schema source format                                                 |
| `MONGOSQL_SCHEMA_FILE_NOT_FOUND` | File mode: file missing                                   | Check `CUBEJS_MONGOSQL_SCHEMA_FILE` path                                 |
| `MONGOSQL_TRANSLATE_FAILED`      | `mongosql::translate_sql` rejected the SQL                | Check column names, types vs schema; check ambiguous JOINs               |
| `MONGOSQL_EXECUTE_FAILED`        | Aggregation pipeline failed at MongoDB                    | Check Mongo logs; reproduce with `mongosql-cli`                          |
| `MONGOSQL_TIMEOUT`               | Query exceeded `CUBEJS_DB_QUERY_TIMEOUT` / legacy `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` | Add a pre-agg, optimize the query, or raise the timeout                  |
| `MONGOSQL_RESULT_TOO_LARGE`      | Cursor returned more rows than `CUBEJS_MONGOSQL_MAX_ROWS` | Add a pre-agg, narrow filters, partition smaller, or raise the cap       |
| `MONGOSQL_CANCELLED`             | Caller fired an `AbortSignal`, or `release()` cancelled the in-flight query | Expected on shutdown / user-cancel — no retry needed                     |

## Troubleshooting

### `MONGOSQL_TRANSLATE_FAILED: ambiguous projection in JOIN`

When a `SELECT` projects bare column names that exist on both sides of a JOIN (e.g. both `orders` and `users` have `created_at`), `mongosql` cannot disambiguate and throws this error. Fixes:

```sql
-- Bad (ambiguous):
SELECT account_id FROM orders JOIN users ON orders.account_id = users.account_id;

-- Good (qualified):
SELECT orders.account_id FROM orders JOIN users ON orders.account_id = users.account_id;

-- Or, when you want both sides:
SELECT orders.created_at AS order_created_at, users.created_at AS user_created_at FROM ...;
```

The driver also emits this code when an explicit-projection JOIN would produce trailing-name collisions (`SELECT a.col, b.col` where both end with `col`) — `mongosql` would silently overwrite one side; the driver refuses up front.

### `MONGOSQL_RESULT_TOO_LARGE`

The driver buffers query results into a JSON array before crossing the napi boundary, so a hard row cap protects against runaway memory. Strategies to fit within the cap:

1. **Add or tune a pre-aggregation.** Cube will route the query to the rollup, which is much smaller.
2. **Narrow the filters.** A `WHERE created_at >= '2026-04-01'` clause often shrinks results by orders of magnitude.
3. **Smaller partitions** for partitioned pre-aggs (`hour` instead of `day`, etc.).
4. **Raise the cap** with `CUBEJS_MONGOSQL_MAX_ROWS=500000` (or wherever your pod's memory budget allows ~ 1 KB / row).

Streaming via `ThreadsafeFunction` is a planned post-MVP enhancement — see [SPEC §8](./SPEC.md#8-open-questions).

### Large `IN (...)` / `NOT IN (...)` lists — Atlas SQL endpoint re-expands large boolean arrays

Real-world Cube queries with `equals` (`IN`) or `notEquals` (`NOT IN`) filters carrying hundreds of identifiers (e.g. `agent_id IN (160 ids)`) hit MongoDB's max BSON nested-object depth (100) on the Atlas SQL endpoint. The failure mode is subtle:

1. **`mongosql` v1.8.5 outputs a *flat* boolean array.** Both `IN (v1..vN)` (and the equivalent `field = v1 OR field = v2 OR …`) and `NOT IN (v1..vN)` translate to a *flat* `$or` / `$and` array (depth 1) — verified empirically against both the local YAML fixture catalog AND a real Atlas SQL endpoint's `sqlGetSchema`-derived catalog (see `crates/native/tests/critic_probe.rs`).
2. **The Atlas SQL proxy re-expands the flat array.** When the driver sends that flat pipeline over the wire to an Atlas SQL endpoint (`*.a.query.mongodb.net`), the proxy / server-side query layer re-expands the array into a right-leaning chain of binary `$or` / `$and`s before passing the aggregate to the underlying MongoDB query engine:

   ```text
   { $or: [LEAF, { $or: [LEAF, { $or: [LEAF, … ] }] }] }
   ```

3. **MongoDB rejects the chain.** For N ≥ ~100 the materialised BSON exceeds the maximum nested-object depth (100), and the server rejects the aggregate with:

   ```text
   Error code 15 (Overflow): BSONObj exceeds maximum nested object depth
   ```

   The error path on a Cube query with 161 `agent_id` values:

   ```text
   pipeline.0.$match.$expr.$let.vars.desugared_sqlAnd_input2.$let.in.$cond.if.$or.0.$or.0.$or.0…
   ```

   (Note: this path is from the *server's* error message — the path the driver SENDS over the wire is flat.)

4. **Collapsing to `$in` / `{$not: {$in: …}}` defeats the re-expansion.** There is no n-ary boolean array left for the proxy to chain-ify. The driver applies a pure pipeline rewrite immediately after translation:
   - **Flatten** any nested `$or` / `$and` chain into a single flat array (defensive; defends against any client-side chain shape from future translators).
   - **Collapse to `$in`** when every `$or` element is a `$eq` against the same field with literal scalars.
   - **Collapse to `{$not: {$in: …}}`** when every `$and` element is a `$ne` against the same field with literal scalars (the `NOT IN` symmetric path). NOTE: this emits `{$not: {$in: …}}` and NOT `{$nin: …}`. MongoDB's `$nin` is a *query* operator (valid only inside `$match.<field>: {$nin: …}`), not an aggregation expression operator. mongosql lands its NOT IN translation inside `$expr`, where `$nin` is rejected with `code 168: Unrecognized expression '$nin'`. Verified empirically against atlas-local.

Both passes are internal to the driver — no SQL changes, no `mongosql` patches. See `crates/native/src/pipeline_rewrite.rs` for the full module and tests. If a future Atlas SQL release stops re-expanding flat boolean arrays, this rewrite becomes a no-op (the walker is shape-agnostic and runs in linear time per pipeline node).

### `MONGOSQL_SCHEMA_NOT_FOUND`

Usually one of:

- Atlas SQL Interface isn't enabled on the cluster yet — check the Atlas UI.
- The first sample hasn't completed — wait a few minutes.
- The wrong database is configured: `__sql_schemas` lives in the database `CUBEJS_DB_NAME` points at, not `admin`.

Confirm in `mongosh` against your URI:

```js
use example;
db.getCollection('__sql_schemas').countDocuments();   // must be > 0
db.getCollection('__sql_schemas').find().limit(1);    // see one schema doc
```

> Use `db.getCollection('__sql_schemas')`, not `db.__sql_schemas` — mongosh's dot accessor doesn't expose collections whose name starts with `_`.

### Schema drift (collection added; queries fail)

The driver refreshes its in-memory schema every `CUBEJS_MONGOSQL_SCHEMA_REFRESH_SEC` seconds (default 300). Newly added collections become queryable after the next refresh. To force a faster cycle in dev, drop the value to e.g. `30`. Production should keep it at 300+ to avoid unnecessary load on Atlas.

For atomic guarantees: refreshes swap the cache atomically on success and keep serving the previous catalog on failure — there's no "schema briefly empty" window.

### `MONGOSQL_CANCELLED` (and SIGTERM-during-pre-agg)

The driver's native side honours both `AbortSignal` (when callers pass one via `query(sql, values, { signal })`) and Cube's `release()` lifecycle. On either:

- The in-flight cursor is cancelled — the next `tokio::select!` poll short-circuits with `MONGOSQL_CANCELLED` rather than waiting for the server-side `maxTimeMS` to fire.
- `release()` drains in-flight queries with a 5-second budget before returning, so a SIGTERM during a long pre-aggregation build doesn't leak connections or waste minutes of MongoDB compute. (Pre-cancellation behaviour: `release()` returned immediately while the cursor kept draining until the configured `CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS` — typically 60s — fired.)

`MONGOSQL_CANCELLED` is the expected error code on graceful shutdown; treat it like a context-cancelled signal in caller code, not as a query-failure to retry. Cube does not pass an `AbortSignal` through to drivers in v1.6.x — the cancellation contract is exercised primarily through `release()` and through direct `MongoSqlDriver` callers.

### Connection issues

- **Atlas IP allowlist**: ensure your Cube nodes' egress IPs (or VPC peer / private endpoint) are in the project's IP Access List.
- **`tls=true` required by Atlas**: `mongodb+srv://` URIs imply TLS; for plain `mongodb://` against TLS-enabled clusters, append `?tls=true`.
- **`directConnection=true`** is required for replica sets whose internal hostnames aren't resolvable from your client (atlas-local, in-cluster mongo without service-DNS).
- **Server selection timeout**: set `serverSelectionTimeoutMS=5000` in the URI to fail fast when probing connectivity from CI; default is 30 s.

## Comparison vs `@cubejs-backend/mongobi-driver`

|                               | `mongosql-cubejs-driver` (this)                           | `@cubejs-backend/mongobi-driver`                 |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Wire protocol to MongoDB      | Direct MongoDB wire (port 27017)                          | MySQL wire to `mongosqld` (port 3307 by default) |
| Translation                   | Client-side via `mongosql` Rust crate                     | Server-side via `mongosqld` (separate process)   |
| Atlas BI Connector dependency | None                                                      | **Required (EOL 30 Sept 2026)**                  |
| JVM                           | None                                                      | None (mongosqld is Go), but a separate process   |
| Auth mechanisms               | SCRAM, MONGODB-AWS, MONGODB-X509 (full mongodb crate set) | SCRAM only via MySQL passthrough                 |
| Schema source                 | `__sql_schemas` collection or YAML/JSON file              | mongosqld config + sample-on-start               |
| Process model                 | In-Cube (Node addon)                                      | Two processes: Cube + mongosqld                  |
| Result transport              | BSON → JSON in-process                                    | MongoDB ↔ mongosqld ↔ MySQL ↔ Cube               |
| TLS termination               | Cube ↔ MongoDB direct                                     | Cube ↔ mongosqld ↔ MongoDB (two hops)            |
| Pre-aggregations              | Supported                                                 | Supported                                        |
| `CUBEJS_DB_EXPORT_BUCKET`     | Not supported                                             | Not supported                                    |

## Examples

| Directory                                        | What it shows                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| [`examples/docker/`](./examples/docker/)         | End-to-end Cube + atlas-local + driver, built with the `Dockerfile` shipped here. |
| [`examples/atlas-prod/`](./examples/atlas-prod/) | Production Atlas configuration with AWS IAM auth via EKS Pod Identity.            |
| [`examples/local-dev/`](./examples/local-dev/)   | Local development loop using atlas-local + file-mode schema (no `__sql_schemas`). |

## Development

```bash
pnpm install
pnpm build              # builds Rust shim + TypeScript
pnpm test               # unit tests (TS + Rust)
make e2e                # docker-compose + integration suite
```

See `make help` for all targets, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the plan → execute → validate → review → document workflow.

For agents: each task in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) is sized to fit a single agent conversation under 128K tokens. Pick one, follow its task spec, complete the loop.

## Architecture

Full system diagram, module map, schema cache lifecycle, BSON→JSON conversion table, and test-pyramid layout: [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

[Apache 2.0](./LICENSE).

## Related

- [Cube.js](https://cube.dev) — the analytics framework
- [`@cubejs-backend/mongobi-driver`](https://www.npmjs.com/package/@cubejs-backend/mongobi-driver) — the EOL'd predecessor (BI Connector)
- [`mongodb/mongosql`](https://github.com/mongodb/mongosql) — the SQL→MQL translator we wrap (Apache-2.0)
- [`mongodb` Rust crate](https://docs.rs/mongodb/) — the official wire-protocol driver
- [napi-rs](https://napi.rs) — the Rust↔Node FFI we use
- [BI Connector EOL notice](https://www.mongodb.com/docs/atlas/bi-connection/) — the deadline that motivates this project

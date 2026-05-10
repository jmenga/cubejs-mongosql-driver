# mongosql-cubejs-driver

[![ci](https://github.com/jmenga/cubejs-mongosql-driver/actions/workflows/ci.yaml/badge.svg)](https://github.com/jmenga/cubejs-mongosql-driver/actions/workflows/ci.yaml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> **Status: pre-alpha.** Project is being scaffolded; no functional release yet. Track progress in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

A native [Cube.js](https://cube.dev) data source driver for MongoDB. Translates SQL to MongoDB Aggregation Pipeline (MQL) client-side via the open-source [`mongosql`](https://github.com/mongodb/mongosql) Rust crate. Speaks the standard MongoDB wire protocol directly to your cluster — no JDBC, no JVM, no `mongosqld`.

Replacement for the `@cubejs-backend/mongobi-driver` path that depends on the **MongoDB BI Connector**, which reaches end-of-life on **30 September 2026** for both Atlas and on-premises deployments.

## What this is and isn't

**Is:**

- A Cube.js driver — install via npm, configure via `CUBEJS_DB_TYPE=mongosql`.
- Native: Rust + napi-rs, distributed as prebuilt binaries.
- Direct to MongoDB: no proxy process, no Federation routing, no extra wire hops.

**Isn't:**

- Not a JDBC bridge.
- Not a CDC-to-warehouse pipeline.
- Not a schema sampler — schema population is up to your deployment (Atlas-managed sampler, EA Schema Builder CLI, or DIY).

## How it works

```
Cube engine
    │ SQL
    ▼
MongoSqlDriver (this package)
    │ napi-rs
    ▼
mongosql (Rust) — translates SQL → MQL using cached schema
    │
    ▼
mongodb (Rust) — executes MQL via Mongo wire protocol on port 27017
    │
    ▼
MongoDB cluster
    ├─ application collections
    └─ __sql_schemas  ◄── populated by Atlas SQL Interface or Schema Builder CLI
```

The Rust shim caches schema in memory, refreshes it every 5 minutes in the background, and translates per-query in microseconds. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full picture.

## Project layout

```
.
├── SPEC.md                  # canonical specification (interfaces, requirements, error contracts)
├── ARCHITECTURE.md          # detailed architecture — read after SPEC
├── IMPLEMENTATION_PLAN.md   # task-by-task plan for agents (current state of work)
├── CONTRIBUTING.md          # plan/execute/validate/review/document workflow
├── src/                     # TypeScript driver (Cube-facing)
├── crates/native/           # Rust shim (mongosql + mongodb crates wired via napi-rs)
├── tests/
│   ├── unit/                # Vitest unit tests
│   └── integration/         # E2E with Docker Compose + atlas-local
├── examples/docker/         # Cube image with the driver installed
└── .github/workflows/       # CI (lint/test), E2E (compose), Release (prebuilt binaries)
```

## Install

```
npm install mongosql-cubejs-driver
# or
pnpm add mongosql-cubejs-driver
```

The package name follows Cube's `${type}-cubejs-driver` resolver convention,
so `CUBEJS_DB_TYPE=mongosql` resolves automatically — no `driverFactory`
override is required for the lookup to succeed (you may still want one if
you need to wire the dialect class explicitly; see
[`examples/docker/cube/cube.js`](./examples/docker/cube/cube.js)).

The package ships a small JavaScript loader plus per-platform prebuilt native
binaries published as separate npm packages. The root package declares each
platform binary as an `optionalDependencies` entry; npm uses your runtime's
`os`, `cpu`, and `libc` to install **only** the matching binary. No local
Rust toolchain is required for end users.

Supported platforms (per SPEC NFR-2):

| Platform                | Sub-package                               |
| ----------------------- | ----------------------------------------- |
| Linux x64 (glibc)       | `mongosql-cubejs-driver-linux-x64-gnu`    |
| Linux arm64 (glibc)     | `mongosql-cubejs-driver-linux-arm64-gnu`  |
| Linux x64 (musl)        | `mongosql-cubejs-driver-linux-x64-musl`   |
| Linux arm64 (musl)      | `mongosql-cubejs-driver-linux-arm64-musl` |
| macOS x64 (Intel)       | `mongosql-cubejs-driver-darwin-x64`       |
| macOS arm64 (Apple Si.) | `mongosql-cubejs-driver-darwin-arm64`     |

Windows (`win32`) is not supported in v0.1.0. If `npm install` cannot find a
matching binary it will fail with a clear "no native binary for your
platform" error from the loader.

## Type handling notes

### Decimal128 values are returned as strings

MongoDB Decimal128 columns are returned as JSON strings — never as JSON
numbers. This is intentional: a JS `Number` (IEEE 754 double) can only
represent ~15-17 significant decimal digits, while Decimal128 carries up
to 34. Returning a number would silently lose precision past the
double-safe range AND would drop the input quantum (e.g. an accounting
balance `"4521.50"` would become `4521.5`, losing the cents-scale digit).

Convert to a number only after deciding your precision strategy. Common
options:

```ts
// Display-only (precision loss acceptable):
const n = Number(row.amount);            // "4521.50" → 4521.5

// Preserve scale, do arithmetic in fixed-point (recommended for money):
import Decimal from 'decimal.js';
const d = new Decimal(row.amount);       // exact

// Server-side aggregation (no JS arithmetic at all):
//   SELECT SUM(amount) ... ← MongoSQL keeps Decimal128 throughout.
```

The string form is the canonical IEEE 754-2008 representation produced by
`bson::Decimal128::to_string`; trailing zeros and scientific notation
faithfully reflect the value as stored.

## Local development

```
pnpm install
pnpm build              # builds Rust shim + TypeScript
pnpm test               # unit tests (TS + Rust)
make e2e                # docker-compose + integration suite
```

See `make help` for all targets.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. The project uses a strict plan → execute → validate → review → document loop with TDD.

For agents: each task in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) is sized to fit a single agent conversation under 128K tokens. Pick one, follow its task spec, complete the loop.

## License

[Apache 2.0](./LICENSE).

## Related

- [Cube.js](https://cube.dev) — the analytics framework
- [`@cubejs-backend/mongobi-driver`](https://www.npmjs.com/package/@cubejs-backend/mongobi-driver) — the EOL'd predecessor (BI Connector)
- [`mongodb/mongosql`](https://github.com/mongodb/mongosql) — the SQL→MQL translator we wrap
- [napi-rs](https://napi.rs) — the Rust↔Node FFI we use

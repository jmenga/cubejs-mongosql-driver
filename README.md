# cubejs-mongosql-driver

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

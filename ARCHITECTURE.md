# Architecture

**Status:** Draft v1
**Last reviewed:** 2026-05-09
**Audience:** Implementing agents. Read after [SPEC.md](./SPEC.md).

## 1. System view

```
┌─────────────── cube container (cubejs/cube:v1.6.x) ─────────────────┐
│                                                                     │
│   Node.js process                                                   │
│   ─────────────────                                                 │
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
│   ──────────────────────────────────                                │
│      ┌─ schema cache ────┐  ◄── refresh task (300s)                 │
│      │ Arc<RwLock>       │              │                           │
│      └──────┬────────────┘              │                           │
│             │                           │                           │
│             ▼                           │                           │
│      mongosql crate ── MQL ──┐          │                           │
│       (SQL → MQL translator) │          │                           │
│                              ▼          │                           │
│      mongodb crate (official) ──────────┘                           │
│             │                  │                                    │
└─────────────┼──────────────────┼────────────────────────────────────┘
              │ MQL queries      │ schema reads
              ▼                  ▼
        MongoDB wire · TLS · port 27017
              │                  │
              ▼                  ▼
        ┌───── MongoDB cluster ──────────────────────────────────┐
        │  database = $CUBEJS_DB_NAME                            │
        │    ├─ application collections                          │
        │    └─ __sql_schemas  ◄── Atlas SQL Interface sampler   │
        │                          (or Schema Builder CLI on EA) │
        └────────────────────────────────────────────────────────┘
```

Two arrows from Rust to the cluster: data queries (MQL) and schema reads — both standard Mongo wire on port 27017. Schema cache is the only stateful thing in the driver. napi-rs is the only language boundary.

## 2. Module map

### 2.1 TypeScript (`src/`)

| File | Responsibility | Depends on |
|---|---|---|
| `index.ts` | Public exports | All others |
| `types.ts` | Public types | (none) |
| `MongoSqlDriver.ts` | `BaseDriver` impl; delegates to native | `native.ts`, `MongoSqlQuery.ts` |
| `MongoSqlQuery.ts` | `BaseQuery` impl; SQL dialect overrides | `@cubejs-backend/schema-compiler` |
| `native.ts` | Type-safe wrapper around the `.node` module | (loads native binary) |

### 2.2 Rust (`crates/native/src/`)

| File | Responsibility | Public to napi |
|---|---|---|
| `lib.rs` | napi-rs surface (`#[napi]` types and methods) | yes — `MongoSqlClient` |
| `client.rs` | `MongoSqlClient` impl — orchestrates schema, translation, execution | no (internal) |
| `schema.rs` | `SchemaSource` enum, `SchemaCache`, refresh task | no |
| `translate.rs` | Wraps `mongosql` crate; converts errors | no |
| `execute.rs` | Wraps `mongodb` crate; cursor draining; BSON → JSON marshaling | no |
| `error.rs` | `Error` type, `From` impls, error-code mapping | no |
| `config.rs` | `ClientConfig` struct + validation | yes (as napi object) |

## 3. Schema management — detailed

### 3.1 Schema source modes

```rust
pub enum SchemaSource {
    /// Read from __sql_schemas collection in the configured database.
    Collection,
    /// Read from a YAML or JSON file on disk.
    File { path: PathBuf },
}
```

### 3.2 Cache lifecycle

```
┌─ MongoSqlClient::new(config) ─────────────────────────────────────┐
│   Build mongodb::Client (lazy connect)                            │
│   Build SchemaSource from config                                  │
│   Build SchemaCache (initially empty Arc<RwLock<MongoSqlSchema>>) │
│   Return MongoSqlClient — NO I/O yet                              │
└───────────────────────────────────────────────────────────────────┘

┌─ test_connection() ───────────────────────────────────────────────┐
│   Run mongo `ping` admin command                                  │
│   Load schema (Collection or File path)                           │
│     - Collection: query __sql_schemas; build mongosql::Catalog    │
│       via build_catalog_from_catalog_schema(...)                  │
│     - File: read+parse YAML/JSON; build same Catalog              │
│   Acquire cache write lock; replace cache contents                │
│   Spawn refresh task (Tokio interval, schema_refresh_sec)         │
│   Return Ok(())                                                   │
└───────────────────────────────────────────────────────────────────┘

┌─ Refresh task (every schema_refresh_sec) ─────────────────────────┐
│   Try load schema (same as testConnection load step)              │
│   On success: write-lock cache, swap                              │
│   On failure: log warning, retry next interval                    │
└───────────────────────────────────────────────────────────────────┘

┌─ query(sql) (per-query, hot path) ────────────────────────────────┐
│   Acquire cache read lock (cheap)                                 │
│   mongosql::translate_sql(default_db, sql, &Catalog, opts)        │
│       → Translation { target_db, target_collection, pipeline }    │
│   Drop read lock (translation is in-memory)                       │
│   Execute MQL via mongodb crate                                   │
│     - Some(coll): db.collection(coll).aggregate(pipeline)         │
│     - None: db.aggregate(pipeline) (database-level)               │
│   Drain cursor up to max_rows; marshal BSON → JSON                │
│   Return rows (or RESULT_TOO_LARGE if cap exceeded)               │
└───────────────────────────────────────────────────────────────────┘
```

**Eager-vs-lazy schema loading.** The current design eagerly loads all `__sql_schemas` documents at startup and caches them. The `mongosql` crate also exposes `get_namespaces(default_db, sql) -> HashSet<Namespace>` which would let us load only the schemas referenced by each query (lazy mode). Eager is sufficient for our scale (~20–50 collections per partner database). If a tenant catalog ever exceeds ~1000 collections, switch the loader to lazy: in `query()`, call `get_namespaces`, fetch any uncached schemas with TTL caching, then translate.

### 3.3 `__sql_schemas` document shape

Each document represents one *collection*'s schema, keyed by `_id` (the collection name) within a database. The `schema.rs` loader collects all such documents from a database, builds a `BTreeMap<String, json_schema::Schema>` (collection → schema), and constructs a `mongosql::catalog::Catalog` via `build_catalog_from_catalog_schema(BTreeMap<db_name, BTreeMap<coll_name, json_schema::Schema>>)`. Reference shape:

```json
{
  "_id": "<arbitrary identifier>",
  "schema": {
    "version": 1,
    "jsonSchema": {
      "bsonType": "object",
      "properties": {
        "<collection_name>": { "bsonType": "object", "properties": { ... } }
      }
    }
  }
}
```

The mapping from this shape to `mongosql::catalog::Catalog` is owned by the `schema.rs` module.

### 3.4 File schema format

Two formats accepted:

```yaml
# YAML form — mirrors __sql_schemas.jsonSchema content
schema:
  version: 1
  jsonSchema:
    bsonType: object
    properties:
      orders:
        bsonType: object
        properties: {...}
```

```json
{
  "schema": {
    "version": 1,
    "jsonSchema": {
      "bsonType": "object",
      "properties": { "orders": { ... } }
    }
  }
}
```

File is parsed once; same internal representation as Collection-mode.

## 4. Query path — detailed

### 4.1 Per-query sequence

```
TS MongoSqlDriver.query(sql)
  │
  ▼ napi-rs (await Promise interop)
Rust MongoSqlClient::query(sql)
  │
  ├─ catalog = self.cache.read().clone()         // O(1) read lock; Arc<Catalog>
  │
  ├─ Translation { target_db, target_collection, pipeline, .. }
  │    = mongosql::translate_sql(                // pure CPU
  │        &self.config.database,                // current_db
  │        &sql,
  │        &catalog,
  │        SqlOptions::default(),
  │      )?
  │
  ├─ db = self.mongo_client.database(&target_db)
  ├─ // pipeline is bson::Bson — convert to Vec<Document> for mongodb crate
  │   let stages: Vec<bson::Document> = bson_array_to_documents(pipeline)?;
  │
  ├─ cursor = match target_collection {
  │     Some(name) => db.collection::<bson::Document>(&name)
  │                     .aggregate(stages).await?,
  │     None       => db.aggregate(stages).await?,    // database-level
  │   };
  │
  ├─ // Drain with row cap; max_time applied to AggregateOptions
  │   while let Some(doc) = cursor.try_next().await? {
  │     if rows.len() >= self.config.max_rows {
  │       return Err(Error::ResultTooLarge);
  │     }
  │     rows.push(bson_to_json(doc)?);
  │   }
  │
  ├─ rows = Vec<serde_json::Value>::with_capacity(1024)
  ├─ while let Some(doc) = cursor.try_next().await? {
  │     rows.push(bson_to_json(doc)?)
  │   }
  │
  └─ Ok(serde_json::Value::Array(rows))
```

### 4.2 BSON → JSON marshaling rules

| BSON type | JSON representation | Notes |
|---|---|---|
| `Double` | `number` | |
| `String` | `string` | |
| `Document` | `object` | Recursively marshaled |
| `Array` | `array` | Recursively marshaled |
| `Boolean` | `boolean` | |
| `Null` | `null` | |
| `Int32` / `Int64` | `number` | (check JS-safe-integer; warn if overflow) |
| `Decimal128` | `string` | Preserves precision; Cube's measure types determine final cast |
| `ObjectId` | `string` (24-char hex) | Standard |
| `DateTime` | `string` (ISO 8601) | Cube parses time dimensions from strings |
| `Binary` | `{ "$binary": "<base64>", "$type": "<hex>" }` | EJSON form |
| `Regex` | `{ "$regex": "...", "$options": "..." }` | EJSON form |
| `Symbol`, `Code`, `Timestamp` | EJSON form | Rare in OLAP |
| `MinKey`, `MaxKey`, `Undefined` | EJSON form (`$minKey: 1`, etc.) | Legacy; surface losslessly even if Cube ignores |

Implementation: thin custom serializer in `execute.rs` calling `serde_json::Value::*` constructors directly — avoids the lossy generic BSON-to-JSON path.

### 4.3 Errors mapped

| Source | Internal `Error` variant | Cube error code |
|---|---|---|
| `mongodb::error::Error` (auth) | `AuthFailed` | `MONGOSQL_AUTH_FAILED` |
| `mongodb::error::Error` (connect) | `ConnectFailed` | `MONGOSQL_CONNECT_FAILED` |
| `mongodb::error::Error` (other) | `ExecuteFailed` | `MONGOSQL_EXECUTE_FAILED` |
| `mongosql::Error::*` | `TranslateFailed { msg }` | `MONGOSQL_TRANSLATE_FAILED` |
| Cursor returned > `max_rows` | `ResultTooLarge` | `MONGOSQL_RESULT_TOO_LARGE` |
| Schema parse / load | `SchemaInvalid` / `SchemaNotFound` | `MONGOSQL_SCHEMA_*` |
| Tokio timeout | `Timeout` | `MONGOSQL_TIMEOUT` |

The napi-rs layer converts each `Error` into a JS `Error` with `code` field set.

## 5. Concurrency model

- The Tokio runtime is provided by napi-rs's `tokio` feature — same runtime used by the `mongodb` crate.
- `MongoSqlClient` is `Send + Sync`; can be shared across Cube's connection-pool calls.
- Schema cache: `Arc<RwLock<Arc<MongoSqlSchema>>>` — outer `RwLock` for swap, inner `Arc` so readers clone cheaply without holding the lock.
- Refresh task: spawned on Tokio, holds a `Weak<MongoSqlClient>` so it auto-stops when the client is dropped.

## 6. Test strategy

### 6.1 Unit tests (Rust, in-tree)

Each `crates/native/src/*.rs` file has `#[cfg(test)]` modules. Targets:

- `schema.rs`: parsing collection documents, parsing YAML and JSON files, error cases.
- `translate.rs`: deterministic SQL → MQL pipeline assertions for ~10 representative queries; error mapping.
- `execute.rs`: BSON → JSON conversion table; cursor pagination logic.
- `client.rs`: cache swap atomicity; refresh task lifecycle.

### 6.2 Unit tests (TypeScript, Vitest)

Each `src/*.ts` file has co-located tests under `tests/unit/`.

- `MongoSqlDriver.test.ts`: config parsing, error code propagation, `dialectClass()`.
- `MongoSqlQuery.test.ts`: SQL output shape for ~20 dialect cases.

### 6.3 Integration tests (Docker Compose, E2E)

Stand up real services and exercise the driver against them:

- `mongodb/mongodb-atlas-local` (with `__sql_schemas` seeded by init script)
- `cubejs/cube:v1.6.x` with the driver installed
- Test runner that issues Cube REST queries → asserts result shapes

Test cases:

- `basic-queries.test.ts` — count, group-by, filter, join across two collections
- `schema-modes.test.ts` — Collection mode and File mode produce identical outputs
- `pre-aggregations.test.ts` — partitioned + incremental refresh + cache hit
- `auth.test.ts` — SCRAM (must work locally; AWS IAM tested in Atlas-only CI later)
- `errors.test.ts` — every documented error code reproduced

### 6.4 Test pyramid

```
                  ┌────────────────┐
                  │ E2E (Docker)   │  ~10–15 tests, slow, real Mongo + Cube
                  ├────────────────┤
                  │ Integration    │  ~30 tests, against atlas-local only
                  │ (Rust)         │  (no Cube layer)
                  ├────────────────┤
                  │ Unit (TS)      │  ~50 tests
                  ├────────────────┤
                  │ Unit (Rust)    │  ~80 tests
                  └────────────────┘
```

## 7. Build & release

### 7.1 Local development

```
pnpm install
pnpm build              # cargo + napi-build → npm/<platform>/*.node + dist/
pnpm test               # vitest (unit + integration with running compose)
pnpm test:rust          # cargo test
pnpm test:e2e           # docker-compose up + run E2E suite
```

### 7.2 CI matrix

| Job | Trigger | Steps |
|---|---|---|
| `lint` | every push | eslint, prettier, rustfmt, clippy |
| `test-rust` | every push | `cargo test --workspace` |
| `test-ts` | every push | `pnpm test:unit` |
| `test-e2e` | every push | docker compose up + `pnpm test:e2e` |
| `build-prebuilds` | on tag | napi-rs prebuilt binaries for 6 platforms |
| `release` | on tag | `npm publish` with prebuilds attached |

### 7.3 Versioning

- Driver follows semver.
- `mongosql` crate version pinned in Cargo.toml; bump driver minor when bumping translator.
- `@cubejs-backend/base-driver` peer-dep range pinned to a known-compatible Cube range.

## 8. Future extensions (not in MVP)

- Win32 platform prebuilds.
- OIDC and Kerberos auth tests (currently SCRAM + IAM only).
- Schema sampler implementation (out of scope per SPEC §7).
- Multi-database queries within one driver (per-tenant scope is one DB).
- Cube cloud integration tests.

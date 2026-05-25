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
| `config.ts` | Env → URI mapping (Cube-standard `CUBEJS_DB_*` + Mongo-specific `CUBEJS_MONGOSQL_*`); duration parser; precedence rules | `types.ts` |
| `MongoSqlDriver.ts` | `BaseDriver` impl; delegates to native | `native.ts`, `MongoSqlQuery.ts`, `config.ts` |
| `MongoSqlQuery.ts` | `BaseQuery` impl; SQL dialect overrides | `@cubejs-backend/schema-compiler` |
| `native.ts` | Type-safe wrapper around the `.node` module | (loads native binary) |

### 2.2 Rust (`crates/native/src/`)

| File | Responsibility | Public to napi |
|---|---|---|
| `lib.rs` | napi-rs surface (`#[napi]` types and methods) | yes — `MongoSqlClient` |
| `client.rs` | `MongoSqlClient` impl — orchestrates schema, translation, execution | no (internal) |
| `schema.rs` | `SchemaSource` enum, `SchemaCache`, refresh task | no |
| `translate.rs` | Wraps `mongosql` crate; converts errors | no |
| `pipeline_rewrite.rs` | Post-translation BSON rewriter — flattens right-leaning `$or` chains and collapses same-field `$eq` disjunctions to `$in` (defeats MongoDB's max-BSON-nested-object-depth limit on large `IN` lists) | no |
| `execute.rs` | Wraps `mongodb` crate; cursor draining; BSON → JSON marshaling | no |
| `error.rs` | `Error` type, `From` impls, error-code mapping | no |
| `config.rs` | `ClientConfig` struct + validation | yes (as napi object) |

## 3. Schema management — detailed

### 3.1 Schema source modes

The driver supports three modes. All three converge on the same `LoadedSchema` shape (a `MongoSqlCatalog` plus a parallel `TableColumns` map keyed by `(db, collection)`); the only difference is the I/O strategy. On the napi-rs wire the discriminant is a string in `ClientConfig.schema_source.kind`:

```rust
// Wire shape across the napi-rs boundary.
pub struct SchemaSource {
    pub kind: String,             // "collection" | "file" | "atlas-sql"
    pub path: Option<String>,     // required for "file"; ignored otherwise
}
```

| Mode (`kind`) | I/O | When to use |
|---|---|---|
| `collection` (default) | `db.<dbname>.__sql_schemas.find()` | Regular MongoDB clusters where the Atlas SQL Interface (or EA Schema Builder) writes the per-collection schema documents directly into the `__sql_schemas` collection. |
| `file` | Read YAML/JSON at `path` | Local dev, schema-as-code, EA without Schema Builder, edge cases. |
| `atlas-sql` | `listCollections` + per-collection `runCommand({sqlGetSchema: name})` | Atlas SQL endpoints (`<cluster>-<id>.a.query.mongodb.net`), which do NOT expose `__sql_schemas` as a queryable collection — schemas live in an internal store and are reachable only via the `sqlGetSchema` admin-style command. Reference: <https://www.mongodb.com/docs/sql-interface/schema/view/>. |

`atlas-sql` semantics:

- Enumerate via `listCollections`, filter out `system.*` and `__sql_schemas`.
- For each remaining name, issue `runCommand({sqlGetSchema: name})`. Per the canonical spec, the response shape is `{ok: 1, metadata: {description}, schema: {version, jsonSchema}}` when a schema is registered, and `{ok: 1, metadata: {}, schema: {}}` when no schema exists. The empty-`schema` case is SKIPPED (not errored) — `ok: 1` alone does not imply a schema was found.
- **Per-collection `sqlGetSchema` calls are fanned out with bounded parallelism** via `futures::stream::try_buffered`. The concurrency cap (constant `ATLAS_SQL_FAN_OUT_CONCURRENCY` in `crates/native/src/schema.rs`, currently 8) is intentionally conservative — it cuts refresh latency on multi-hundred-collection databases from `N × RTT` to roughly `ceil(N / 8) × RTT` while leaving plenty of headroom on the Atlas SQL control plane. Output order is preserved so the per-collection log messages line up with input order. The fan-out helper (`bounded_fan_out`) is extracted as a pure async function so it can be unit-tested without a live mongo client. **It short-circuits on the first `Err`**: a misconfiguration that fails for every collection (e.g. `code 59 CommandNotFound` when atlas-sql mode is pointed at a regular cluster) surfaces in `O(concurrency)` RTTs, not `O(N)` — the previous `.buffered().collect::<Vec<_>>().await` shape drained the entire input even after one call failed.
- Same `(catalog, columns)` output as the other two modes, keyed under `db_name`. No file-mode-style placeholder rewriting.
- If `sqlGetSchema` errors on the wire, the loader branches on the MongoDB server-side error code so the hint is actually actionable:
  - Code 13 (`Unauthorized`) → "user lacks `sqlGetSchema` privileges; grant `atlasAdmin` (project) or `clusterMonitor` + `readAnyDatabase` (on `admin`); configure via Atlas UI Project → Security → Database Access — see <https://www.mongodb.com/docs/atlas/security-add-mongodb-users/>." The role names are embedded directly in the error message rather than relying on operator follow-through to docs, because no canonical MongoDB docs page deep-links to the privilege table.
  - Code 59 (`CommandNotFound`) → "endpoint does not implement `sqlGetSchema`; atlas-sql mode requires a `*.a.query.mongodb.net` endpoint; use collection mode for regular clusters."
  - Any other failure → generic `MONGOSQL_SCHEMA_INVALID` with the underlying message routed through `redact_uri_creds` so a future mongodb-crate variant whose Display embeds the URI can't leak credentials.

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
│   Load schema (Collection, File, or Atlas SQL path)               │
│     - Collection: query __sql_schemas; build mongosql::Catalog    │
│       via build_catalog_from_catalog_schema(...)                  │
│     - File:       read+parse YAML/JSON; build same Catalog        │
│     - Atlas SQL:  listCollections → filter system.* + __sql_schemas│
│                   → runCommand({sqlGetSchema: name}) per remaining │
│                   → skip empty-`schema` responses; parse populated │
│                   ones; build same Catalog                        │
│   Acquire cache write lock; replace cache contents                │
│   Spawn refresh task (Tokio interval, schema_refresh_sec)         │
│   Return Ok(())                                                   │
└───────────────────────────────────────────────────────────────────┘

┌─ Refresh task (every schema_refresh_sec) ─────────────────────────┐
│   Try load schema (same as testConnection load step)              │
│   On success: write-lock cache, swap                              │
│   On failure: log warning, retry next interval                    │
│   Atlas SQL note: Atlas updates schemas on its own cadence        │
│   ("Configure schema update schedule" in the Atlas UI), so        │
│   periodic refresh is load-bearing for atlas-sql just like        │
│   collection mode.                                                │
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

### 4.0 Config / connection lifecycle

The driver's TypeScript layer is the single place that translates env vars into a MongoDB connection URI. The Rust client accepts the URI verbatim and hands it to `mongodb::Client::with_uri_str`; the mongodb crate parses every option it supports (see `~/.cargo/registry/.../mongodb-3.7.0/src/client/options.rs:2262-2790` for the canonical match list).

```
process.env
  │
  ▼
src/config.ts :: resolveUriConfig(overrideUri?, env)
  │
  ├─ pick base URI by precedence:
  │     constructor `uri`  >  CUBEJS_DB_URL  >  CUBEJS_DB_URI
  │     >  compose mongodb://[user:pass@]host[:port]/[db] from
  │        CUBEJS_DB_HOST + _PORT + _USER + _PASS + _NAME
  │     (HOST required when no URL/URI; user/pass URL-encoded)
  │
  ├─ for each (env var → URI param) mapping in URI_PARAM_SPECS:
  │     - parse + validate value (bool / int / duration / non-empty)
  │     - SKIP if the URI's existing query string already has the key
  │       (user-set URI params ALWAYS win — case-insensitive match)
  │     - otherwise append `key=encodeURIComponent(value)`
  │
  ├─ resolve `queryTimeoutMs`:
  │     CUBEJS_DB_QUERY_TIMEOUT (duration-aware; throws on garbage)
  │     >  CUBEJS_MONGOSQL_QUERY_TIMEOUT_MS (legacy; lenient)
  │
  └─ return { uri, queryTimeoutMs }
        │
        ▼
MongoSqlDriver.buildConfig — also reads CUBEJS_DB_NAME (required),
CUBEJS_MONGOSQL_SCHEMA_* (mode / file / refresh / fail-open), and
CUBEJS_MONGOSQL_MAX_ROWS. Hands the final MongoSqlConfig to the native
client constructor.
        │
        ▼
crates/native/src/client.rs :: MongoSqlClient::new(config)
  │   stores config; defers any I/O.
  ▼
…on first testConnection() / query():
mongodb::Client::with_uri_str(config.uri)
  │   parses every URI param into ClientOptions (pool, TLS, timeouts,
  │   appName, compressors, …). Errors here surface as
  │   MONGOSQL_CONNECT_FAILED.
```

URI params honoured (env var ↔ URI param):

| Env var | URI param |
|---|---|
| `CUBEJS_DB_SSL` | `tls` |
| `CUBEJS_DB_MAX_POOL` / `CUBEJS_DB_MIN_POOL` | `maxPoolSize` / `minPoolSize` |
| `CUBEJS_DB_IDLE_TIMEOUT` | `maxIdleTimeMS` (duration string or ms) |
| `CUBEJS_MONGOSQL_MAX_CONNECTING` | `maxConnecting` |
| `CUBEJS_MONGOSQL_WAIT_QUEUE_TIMEOUT_MS` | `waitQueueTimeoutMS` |
| `CUBEJS_MONGOSQL_CONNECT_TIMEOUT_MS` | `connectTimeoutMS` |
| `CUBEJS_MONGOSQL_SOCKET_TIMEOUT_MS` | `socketTimeoutMS` |
| `CUBEJS_MONGOSQL_SERVER_SELECTION_TIMEOUT_MS` | `serverSelectionTimeoutMS` |
| `CUBEJS_MONGOSQL_HEARTBEAT_FREQUENCY_MS` | `heartbeatFrequencyMS` |
| `CUBEJS_MONGOSQL_APP_NAME` | `appName` |
| `CUBEJS_MONGOSQL_RETRY_WRITES` / `_RETRY_READS` | `retryWrites` / `retryReads` |
| `CUBEJS_MONGOSQL_COMPRESSORS` | `compressors` |

`CUBEJS_DB_QUERY_TIMEOUT` is the only Cube-standard knob that does NOT map to a URI param — it controls the aggregation pipeline's `maxTimeMS`, applied by the Rust client on each query. The `mongodb` crate's `maxTimeMS` is per-operation and not part of the connection string.

Duration parser (used by `CUBEJS_DB_QUERY_TIMEOUT` and `CUBEJS_DB_IDLE_TIMEOUT`):

  - bare number → milliseconds (`"60000"` → 60_000)
  - `<N>ms` → milliseconds
  - `<N>s` → seconds → milliseconds
  - `<N>m` → minutes → milliseconds
  - `<N>h` → hours → milliseconds

Anything else throws `MONGOSQL_CONFIG_INVALID` naming the env var.

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
  ├─ // Post-translation pipeline rewrite (pure, CPU-only). Walks every
  │   // BSON node in the pipeline and at every `$or` / `$and` location:
  │   //   1. Flattens any nested chain into a flat array (defensive).
  │   //   2. Collapses same-field `$eq` disjunctions to `$in` and
  │   //      same-field `$ne` conjunctions to `{$not: {$in: ...}}`
  │   //      (NOT `$nin` — invalid in `$expr` context, see
  │   //      `pipeline_rewrite.rs` module docstring).
  │   //
  │   // Why: `mongosql::translate_sql` v1.8.5 outputs a FLAT `$or` /
  │   // `$and` (depth 1) — but the Atlas SQL endpoint's proxy
  │   // re-expands flat boolean arrays into a right-leaning chain of
  │   // binary `$or` / `$and`s server-side. For N ≥ ~100 the chain
  │   // busts MongoDB's max BSON nested-object depth (100). Collapsing
  │   // to `$in` / `$nin` defeats the re-expansion (no n-ary boolean
  │   // array left to chain-ify). See `crates/native/src/pipeline_rewrite.rs`
  │   // and the README "Large `IN (...)` / `NOT IN (...)` lists"
  │   // troubleshooting section.
  │   pipeline_rewrite::flatten_or_chains_and_collapse_to_in(&mut pipeline);
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
  ├─ // Authoritative column list — name + Cube generic type — derived
  │   // from mongosql's `Translation::{select_order, result_set_schema}`
  │   // BEFORE the cursor drains. The pre-aggregation upload path
  │   // (`downloadQueryResults`) consumes this list verbatim; we no
  │   // longer sniff types from row values (that path was non-
  │   // deterministic in multi-partition pre-aggregations because
  │   // mongosql's `$project` stage construction iterates a HashMap-
  │   // backed schema, producing different field orders across
  │   // translations of the *same* SQL, and divergent column orders
  │   // broke Cube Store UNIONs with `type_coercion` errors).
  │   let types: Vec<ColumnType> = column_types_from_schema(
  │       &translation.select_order,
  │       &translation.result_set_schema,
  │   );
  │
  └─ Ok({ rows, types })   // napi-rs serialises as `{rows, types}`
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

#### Per-column types from mongosql metadata

Alongside the marshalled rows, the executor returns an ordered
`Vec<{name, type}>` derived from `mongosql::Translation::{select_order,
result_set_schema}`. `select_order` is the projection order parsed from
the SQL SELECT clause; `result_set_schema` is the per-field
`json_schema::Schema` declaration. The driver maps an atomic
`bson_type` → Cube generic-type string per:

| BSON type | Cube generic type |
|---|---|
| `String`, `ObjectId` | `string` |
| `Int` | `int` |
| `Long` | `bigint` |
| `Double`, `Decimal` | `decimal` |
| `Bool` | `boolean` |
| `Date`, `Timestamp` | `timestamp` |
| `Object`, `Array`, `BinData`, `Regex`, `Symbol`, code-variants, `MinKey`, `MaxKey`, `DbPointer`, `Undefined`, `Null` | `text` |

**Union resolution (`any_of`).** mongosql's
`TryFrom<Schema> for json_schema::Schema`
(`mongosql/src/schema/definitions.rs` lines 730-743 at git-rev 4a159e5)
emits `{ bson_type: None, any_of: Some(variants) }` for *every*
non-atomic schema — nullable columns, GROUP BY columns, aggregate
outputs. **It never emits `BsonType::Multiple` at runtime.** Practical
shapes the driver sees:

| SQL | Schema mongosql emits | Cube generic type |
|---|---|---|
| `SUM(amount)` over decimal | `any_of: [Decimal, Null]` | `decimal` |
| `COUNT(*)` / `COUNT(col)` | `any_of: [Int, Long]` | `bigint` |
| `account_id` from a nullable string column | `any_of: [String, Null]` | `string` |
| `AVG(col)` over int | `any_of: [Double, Null]` | `decimal` |
| Heterogeneous union (`SELECT CASE ... END`) | `any_of: [String, Int]` | `text` |

Resolution rule (see `execute.rs::cube_type_for_schema`):

1. If `bson_type` is a single atomic (no `any_of`), map directly.
2. Otherwise, walk `any_of`, drop `Null` variants, deduplicate the
   remaining atomic names. If exactly one distinct non-null variant
   remains → map it. If 2+ remain and they're all numeric, **widen
   upwards**: `Int + Long → bigint`, anything-with-`Double`-or-`Decimal`
   → `decimal`. Any other multi-variant union → `text`.
3. Nested `any_of` (e.g. `any_of: [{any_of: [Int, Null]}, ...]`) is
   flattened recursively — currently theoretical (mongosql's algebra
   layer collapses unions before the JSON-Schema conversion) but handled
   defensively.
4. `bson_type: None` AND `any_of: None` (Schema::Any) → `text`. Same for
   any_of with object/array variants that can't be reduced to a single
   atomic name.

The TS-side `flattenRow` rule applies here too — for a multi-key
envelope the name is `<namespace>__<column>` (an empty-string namespace
yields `__<column>` to match flattenRow byte-for-byte); for a single-key
envelope it's the bare column.

#### Post-flatten row-shape normalization (`normalizeRowShape`)

`flattenRow` unwraps mongosql's per-collection envelope into a flat
JS object keyed by column name. But there's a second issue mongosql's
`$project` introduces that `flattenRow` alone doesn't address:

> **mongosql's `$project` of a nested-path expression (e.g.
> `agent.displayName`) OMITS the field from the output row entirely
> when the source document doesn't carry that path.** It does NOT emit
> `null`. With a query that `ORDER BY <nested-field> ASC`, the rows
> missing the field sort to the top of the result (nulls-first), so the
> row at index 0 is sparse.

Downstream consumers compile their row→member extraction plan from the
keys present in **row 0**. Cube's native `getFinalQueryResult`
transform (in `@cubejs-backend/native`) is the canonical example —
a sparse row 0 causes it to drop the column from EVERY row in the
response, even rows that DO have the value. The production symptom was
the frontend's `useAgentsList` query (500 rows, 497 with names
populated, 3 without; sorted ascending → row 0 sparse → all 500 rows
missing the `configs.agent_display_name` key → KPI tiles showed 0).

Fix lives in `src/MongoSqlDriver.ts::normalizeRowShape` and runs AFTER
`flattenRows` on both the `query()` (regular `/load`) and
`downloadQueryResults` (pre-aggregation build) paths:

| Call site | Key source | Why |
|---|---|---|
| `query()` | Union of keys across all rows | See "Why union-of-keys at `query()`" below. |
| `downloadQueryResults()` | `types.map(t => t.name)` from `mongosql::Translation::select_order`, then union-of-keys as a belt-and-braces second pass | Type list is deterministic and covers the (rare) edge case where a column is missing from EVERY row — a union alone would still miss it. The second union pass picks up any stray row keys outside the type list so the "every row has the same key set" contract holds symmetrically with `query()`. |

**Why union-of-keys at the `query()` layer (rather than the typed null-fill used in `downloadQueryResults`)?** `BaseDriver.query()` returns rows only — the type list isn't part of its contract. Internally we could call `client.queryWithTypes()` and use the types, but it would buy nothing: union-of-keys produces the same result for any rowset where at least one row has each projected column (which is the actual on-the-wire shape — mongosql's sparse-omission only drops keys from individual rows, never from an entire column). `downloadQueryResults` uses the type list because its contract surfaces types to Cube Store anyway; `query()` uses union because it's all that's needed.

Net effect: every row in the result set carries every key in the union
(or in the type list, for the download path), with `null` filling any
gap. `flattenRow` runs first to unwrap the envelope; `normalizeRowShape`
runs second on the post-flatten rows. Iteration is O(rows × cols). At
the `MAX_ROWS=100000` pre-agg cap with a ~20-column projection this is
roughly 2M property-existence checks and stays under 100ms in practice.

Regression harness: `tests/unit/driver.test.ts` (the
"row-shape normalization" describe block + the direct
`normalizeRowShape` test), `tests/integration/row-shape-normalization.test.ts`
(real atlas-local with sparse-nested-path docs), and the
`sparse nested-path` test in `tests/cube-e2e/cube-e2e.test.ts` (full
Cube `/load` round-trip).

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

# T00 Spike — `mongosql` crate findings

**Date:** 2026-05-09
**Status:** PROCEED — but SPEC and ARCHITECTURE require corrections (see "Recommended next steps"). No license blocker. Public API is usable, with naming/shape differences from what was assumed.

---

## 1. License

**Verdict: Apache-2.0. Compatible. PROCEED.**

Evidence (verbatim from upstream `LICENSE`, fetched from https://raw.githubusercontent.com/mongodb/mongosql/main/LICENSE):

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
```

GitHub's repo metadata (https://api.github.com/repos/mongodb/mongosql) confirms the same:

```json
"license": {"key":"apache-2.0","name":"Apache License 2.0","spdx_id":"Apache-2.0"}
```

No SSPL, no copyleft. Apache-2.0 is permissive and compatible with the cubejs-mongosql-driver project's MIT license (or whatever the project ends up adopting).

---

## 2. Crate availability

**Verdict: NOT on crates.io. Must depend on it as a git source (pinned commit).**

Evidence:

- `https://crates.io/api/v1/crates/mongosql` returns `{"errors":[{"detail":"crate `mongosql` does not exist"}]}`.
- The repo at https://github.com/mongodb/mongosql is a Cargo workspace whose `mongosql/Cargo.toml` declares:
  ```toml
  [package]
  name = "mongosql"
  version = "0.0.0"
  ```
  i.e. the version is the canonical Rust "we never published this" placeholder.
- The repo is public (visibility: `public`), Apache-2.0, default branch `main`. Last `pushed_at` is 2026-05-08 — actively maintained.

**How we depend on it:**

```toml
[dependencies]
mongosql = { git = "https://github.com/mongodb/mongosql.git", rev = "<pin a commit SHA>" }
```

Sub-crates we may also need to pull in via the workspace:
- `agg-ast` (path dep of mongosql) — provides `agg_ast::definitions::Namespace` which is part of the public API surface (see §3 below).
- We do **not** need `mongosql-c`, `mongosql-cli`, `mongosqltranslate`, `service`, or `schema-builder-library`. They are siblings, not transitive deps.

**Risk:** because the upstream version is `0.0.0` and never published, semver is meaningless. We must pin a commit SHA, not a branch, and treat upgrades as deliberate.

---

## 3. Public API

**Verdict: Usable. The shapes differ from SPEC §5.2 / ARCHITECTURE §3 assumptions in three meaningful ways (called out below).**

### Schema / Catalog types

The catalog type is `mongosql::catalog::Catalog`, defined in `mongosql/src/catalog/mod.rs`:

```rust
use crate::schema::Schema;
use agg_ast::definitions::Namespace;
use std::collections::BTreeMap;

#[derive(Debug, PartialEq, Eq, Default)]
pub struct Catalog {
    schemas: BTreeMap<Namespace, Schema>,
}

impl Catalog {
    pub fn new(schemas: BTreeMap<Namespace, Schema>) -> Catalog { ... }
    pub fn get_schema_for_namespace(&self, namespace: &Namespace) -> Option<&Schema> { ... }
}

impl FromIterator<(Namespace, Schema)> for Catalog { ... }
```

Note: the inner `schemas` field is **private**. The intended construction paths are `Catalog::new(map)`, `FromIterator`, or one of the two helper constructors exposed at crate root in `mongosql/src/lib.rs`:

```rust
/// Converts the given base64-encoded bson document into a Catalog. This must be a base64 encoded
/// string of a BSON slice/vec (bson::to_vec(...))
pub fn build_catalog_from_base_64(base_64_doc: &str) -> Result<Catalog>

/// build_catalog_from_catalog_schema converts a BTreeMap of json_schema::Schema objects into a Catalog.
pub fn build_catalog_from_catalog_schema(
    catalog_schema: BTreeMap<String, BTreeMap<String, json_schema::Schema>>,
) -> Result<Catalog>
```

The schema doc shape is `{ db_name: { coll_name: <json_schema::Schema> } }`. The `json_schema::Schema` type is exposed via `mongosql::json_schema::Schema` (re-exported by `pub mod json_schema;` in `lib.rs`).

The `Namespace` type lives in the sibling `agg-ast` crate:
```rust
agg_ast::definitions::Namespace { database: String, collection: String }
```
We must add `agg-ast` as a (workspace) dep alongside `mongosql`.

### Translation function

In `mongosql/src/lib.rs`:

```rust
/// Returns the Mql translation for the provided Sql query in the
/// specified db.
pub fn translate_sql(
    current_db: &str,
    sql: &str,
    catalog: &Catalog,
    sql_options: SqlOptions,
) -> Result<Translation>
```

**The function is named `translate_sql`, not `translate`.** SPEC §5.2 and IMPLEMENTATION_PLAN T07 call it `mongosql::translate(...)`; both must be updated. The signature also takes a `&str` for `current_db` (which `mongosql` falls back to when the SQL doesn't qualify the database) and a `SqlOptions` struct — neither of which appear in our SPEC.

`SqlOptions` (in `mongosql/src/options/mod.rs`):
```rust
#[derive(Debug, Copy, Clone, Default)]
pub struct SqlOptions {
    pub exclude_namespaces: ExcludeNamespacesOption,
    pub schema_checking_mode: SchemaCheckingMode,
    pub allow_order_by_missing_columns: bool,
}
```

The CLI uses:
```rust
let options = mongosql::options::SqlOptions {
    allow_order_by_missing_columns: true,
    ..Default::default()
};
```

We should mirror that default.

There is also a related helper:
```rust
pub fn get_namespaces(
    current_db: &str,
    sql: &str,
) -> Result<BTreeSet<agg_ast::definitions::Namespace>>
```
The CLI uses this **before** translation, to determine which `__sql_schemas` documents must be loaded — only schemas for the namespaces actually referenced by the query. This is important and is **not** in our current ARCHITECTURE design (which assumed loading all schemas eagerly at startup).

### Translation result — does it expose target collection?

Verbatim from `mongosql/src/lib.rs`:

```rust
/// Contains all the information needed to execute the Mql translation of a Sql query.
#[derive(Debug)]
pub struct Translation {
    pub target_db: String,
    pub target_collection: Option<String>,
    pub pipeline: bson::Bson,
    pub result_set_schema: json_schema::Schema,
    pub select_order: Vec<Vec<String>>,
}
```

Three deltas vs. the SPEC §5.2 / IMPLEMENTATION_PLAN T07 assumed shape:

1. **`target_collection` is `Option<String>`, not `String`.** The CLI shows what to do when it's `None`:
   ```rust
   let results = if let Some(target_collection) = translation.target_collection {
       db.collection::<Document>(target_collection.as_str()).aggregate(pipeline).run()?
   } else {
       db.aggregate(pipeline).run()?  // database-level aggregate
   };
   ```
   Driver code MUST handle the `None` branch (database-level aggregation, not collection-level).
2. **`pipeline` is `bson::Bson` (an Array variant), not `Vec<bson::Document>`.** The CLI unwraps it:
   ```rust
   let bson::Bson::Array(pipeline) = translation.pipeline else { return Err(...); };
   ```
3. **Two extra fields we'll likely want:** `result_set_schema` (the JSON Schema of the row shape — useful for `tablesSchema()` introspection) and `select_order` (column order for the result set, important for Cube which expects a stable column order matching the SQL `SELECT` list).

### Whether translation result includes target collection

**Yes, but optionally.** The driver implementation must:
- If `Some(coll)`: `client.database(&t.target_db).collection::<Document>(&coll).aggregate(pipeline).await`
- If `None`: `client.database(&t.target_db).aggregate(pipeline).await` (database-level — used for queries with no FROM clause or with array literal sources)

The CLI's `run_query_and_display_results` is the canonical reference.

---

## 4. napi-rs + tokio + mongodb compatibility

**Verdict: Compatible. Required feature flag on `napi`: `tokio_rt` (or `async`). The mongodb crate's default async runtime is tokio, which is exactly what napi-rs's `tokio_rt` feature provides.**

Evidence — napi-rs docs (https://napi.rs/docs/concepts/async-fn):

> "You must enable the **async** or **tokio_rt** feature in `napi` to use `async fn`"

Recommended Cargo.toml:
```toml
[dependencies]
napi = { version = "3", features = ["async"] }
```

Per the same page, when you `await` a Tokio future inside a `#[napi] async fn`, napi-rs runs it on its Tokio runtime and produces a JS `Promise`. Example given:
```rust
#[napi]
pub async fn read_file_async(path: String) -> Result<Buffer> {
  let content = fs::read(path).await?;
  Ok(content.into())
}
```

Evidence — mongodb crate (https://www.mongodb.com/docs/drivers/rust/current/runtimes/):

> "The Rust driver supports the `tokio` asynchronous runtime crate, which is the default runtime."
> "The driver uses the `tokio` runtime by default, so you can use this runtime without specifying any feature flags in your project's `Cargo.toml` file."
> "Beginning in Rust driver v3.0, `tokio` is the **only** supported asynchronous runtime."

Combined: a `#[napi] async fn` body that does `mongodb::Client::with_uri_str(uri).await` will execute on napi-rs's managed Tokio runtime, which is exactly what mongodb v3 expects. There is no "no reactor running" hazard, because napi-rs ensures the Tokio runtime is alive whenever the `async fn` body runs.

**Required feature flags (concrete):**
```toml
[dependencies]
napi = { version = "3", features = ["async", "napi6"] }   # or tokio_rt instead of async
napi-derive = "3"
mongodb = "3"   # tokio is implicit / default
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

Note: I did not run a hello-world (the spike's review-checklist item was relaxed by the user prompt: "You don't need to actually run code — pulling the relevant doc paragraphs is enough"). The compatibility claim is supported by official docs, not a working binary. **Recommendation: add a 5-minute smoke test in T03 (before T04+ commits) that does `Client::with_uri_str("mongodb://localhost:27017/").await?.list_database_names().await?` from a `#[napi] async fn` to confirm at runtime.**

---

## 5. Streaming vs buffering

**Verdict: There is NO `async iterator` / `AsyncGenerator` macro in napi-rs. Streaming is possible but not via a clean `for await` shape. Practical options, in order of complexity:**

### Option A — Buffer (simplest, recommended for v0.1.0)

`#[napi] async fn query(...) -> napi::Result<serde_json::Value>` collects all rows into a `Vec<Value>`, returns once. JS sees a `Promise<Row[]>`.

Pros: trivial. Matches Cube's `BaseDriver.query()` contract, which itself returns `Promise<Row[]>`.
Cons: large result sets sit in Rust heap before crossing the FFI.

**This is what SPEC §5.2 currently implies** (`async query(sql) -> Promise<Row[]>`), and **it is fine for v0.1.0** as long as we set a hard row cap.

### Option B — Sync generator yielded after async drain (medium)

napi-rs has a `#[napi(iterator)]` macro implementing the JS `Iterator` protocol via the `Generator` trait. From `examples/napi/src/generator.rs`:
```rust
#[napi(iterator)]
pub struct Fib { current: u32, next: u32 }

#[napi]
impl Generator for Fib {
    type Yield = u32;
    type Next = i32;
    type Return = ();
    fn next(&mut self, value: Option<Self::Next>) -> Option<Self::Yield> { ... }
}
```
This produces `Symbol.iterator` (synchronous), not `Symbol.asyncIterator`. We could async-drain the cursor into an internal `VecDeque`, then hand JS a sync iterator. This is just buffering with a different surface — does not help peak memory.

### Option C — Push via ThreadsafeFunction callback (complex)

`ThreadsafeFunction<T>` (https://napi.rs/docs/concepts/threadsafe-function) lets Rust call a JS callback repeatedly:
```rust
#[napi]
pub fn call_threadsafe_function(callback: ThreadsafeFunction<u32>) -> Result<()> { ... }
```
TS surface: `callback: (err: null | Error, result: number) => void`. Wrapping this into `AsyncIterable<Row>` happens on the TS side (we'd write a `pull`-style wrapper). This is the only way to do true streaming today. Significant engineering cost; not worth it for v0.1.0.

### Recommendation for SPEC NFR-1 (large result sets)

Update SPEC NFR-1 to:
1. **v0.1.0: buffering with row cap** — default `CUBEJS_MONGOSQL_MAX_ROWS = 100_000`, fail with `MONGOSQL_RESULT_TOO_LARGE` above the cap. Honest about the limit instead of pretending to stream.
2. Drop "Stream results using cursors (no full-result-set buffering for large queries)" from FR-4 — that's aspirational and contradicts the chosen v0.1.0 transport. Replace with: "Drain cursors into the result buffer and surface `MONGOSQL_RESULT_TOO_LARGE` if the bound is exceeded."
3. Track Option C (ThreadsafeFunction streaming) as a **post-MVP** enhancement.

---

## Recommended next steps for the user

### Decisions required before T03+ can begin

- [ ] **Confirm git-pinned mongosql is acceptable.** No crates.io publication; we'll vendor-via-git with a SHA pin and a manual update process.
- [ ] **Approve the result-buffering trade-off** (SPEC NFR-1 update above) before T08/T09 commit to a buffered transport.
- [ ] **Confirm `agg-ast` git dep is acceptable.** Same repo, same commit pin, but it's a second dep entry.

### Edits to SPEC.md / ARCHITECTURE.md required

- [ ] **SPEC §5.2 / ARCHITECTURE §3.1** — rename `MongoSqlCatalog` to `mongosql::catalog::Catalog`. The schema container is `Catalog`, constructed via `mongosql::build_catalog_from_catalog_schema(BTreeMap<String, BTreeMap<String, json_schema::Schema>>)`.
- [ ] **IMPLEMENTATION_PLAN T07** — function is `mongosql::translate_sql`, not `mongosql::translate`. Signature is `(current_db: &str, sql: &str, catalog: &Catalog, sql_options: SqlOptions) -> Result<Translation>`.
- [ ] **IMPLEMENTATION_PLAN T07 / SPEC §5.2** — `Translation.target_collection` is `Option<String>`. Driver code MUST handle the database-level aggregation branch when `None`.
- [ ] **IMPLEMENTATION_PLAN T07** — `Translation.pipeline` is `bson::Bson` (Array variant), not `Vec<bson::Document>`. Unwrap before passing to `aggregate`.
- [ ] **ARCHITECTURE §3 / SPEC FR-3** — schema loading should use `mongosql::get_namespaces(current_db, sql)` to determine *which* `__sql_schemas` documents are needed, not load every doc up-front. This may be a cache-on-first-query model rather than the eager refresh-task model SPEC describes. Worth a design rethink.
- [ ] **ARCHITECTURE §3.1** — the schema cache should hold `Catalog` (not `MongoSqlCatalog`); also note `Catalog` is `Default` and constructible via `FromIterator<(Namespace, Schema)>`, so the merge operation in T04 is a `BTreeMap` extend, not a custom merge.
- [ ] **SPEC NFR-1 / FR-4** — replace the streaming claim with the buffered + row-cap model (see §5 above).
- [ ] **SPEC §5.2** — add `target_db: string` to the JS-side translation result type for completeness (or hide it inside the Rust side; either is fine, but pick one).
- [ ] **SPEC §5.3** — schema document format should be re-read against the actual `json_schema::Schema` shape (the CLI uses `bsonType`, `properties` — confirm this matches what `__sql_schemas` documents look like in Atlas).

### Red flags

- **None blocking.** License is clean, the API is usable, and the runtime story is sound.
- **One amber flag:** `mongosql` is `version = "0.0.0"` and not published. We're shipping production code that depends on a git pin. This is fine if we accept "MongoDB stewards this repo and we'll move pins deliberately." Document this prominently in the README's "Stability" section.
- **One process flag:** the original SPEC type names were invented. The drift between SPEC §5.2 (`MongoSqlCatalog`, `Translation { target_collection: String, pipeline: Vec<bson::Document> }`) and reality is exactly the kind of gap the critic-review v1 flagged. The `Discoveries` section of IMPLEMENTATION_PLAN.md has been updated; SPEC.md and ARCHITECTURE.md edits should be made (but were intentionally not made in this spike — that is a follow-up doc-edit task for the user to authorise).

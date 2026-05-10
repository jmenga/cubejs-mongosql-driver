# Critic Review v1

**Reviewer:** general-purpose agent (autonomous critique pass)
**Reviewed:** 2026-05-09 (post-initial-scaffold)
**Files reviewed:** SPEC.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, CONTRIBUTING.md

This file is the unedited critique. Material outcomes are folded into the relevant docs (see [IMPLEMENTATION_PLAN.md → Critic review log](../IMPLEMENTATION_PLAN.md#critic-review-log)).

---

## WORKING WELL

- **Document hierarchy is clean.** SPEC = contract, ARCHITECTURE = how, PLAN = sequenced work, CONTRIBUTING = process. Cross-references resolve. CONTRIBUTING.md:221 explicitly forbids editing SPEC/ARCH without user agreement — that's the right guardrail for an agent fleet.
- **Fail-closed schema load + atomic swap** (SPEC §FR-3, ARCH §3.2) is right; `Arc<RwLock<Arc<Catalog>>>` outer-swap/inner-clone idiom (ARCH:246) is correct and avoids holding the lock across translate.
- **Error contracts** (SPEC §6) are concrete, code-keyed, and machine-checkable. Good for T17 to validate against.
- **Per-task Inputs/Outputs/Validation/Review** structure is the right shape for stateless agents.
- **Out-of-scope list** (SPEC §7) is unusually disciplined — Win32, sampler, EXPORT_BUCKET explicitly deferred.

## CRITICAL

- **T03–T09 ship without a `mongosql` crate spike, yet Open Questions in PLAN:801–803 admit the public API is unknown.** `MongoSqlCatalog` (T04 outputs:204), `Translation { target_collection }` (T07 outputs:333), and "pipeline.first_collection()" (ARCH:195) are invented. If the crate doesn't expose these, T04, T07, T08 cascade-fail and napi surface (T09) needs a re-do. **Add T03.5 = "mongosql crate spike" as a hard prerequisite** — produce a one-page note pinning crate version, listing actual public types/functions, and confirming whether translate yields collection name. Without this, T04+ are speculative.
- **`mongosql` is not on crates.io as a public package** (last I checked). SPEC §1 calls it "the open-source mongosql Rust crate" but the repo at github.com/mongodb/mongosql may not publish a usable lib target, and licensing (SSPL) needs verifying before npm distribution. **No license-compatibility check anywhere in the plan.** This blocks T21 publish.
- **napi-rs async + `mongodb` crate Tokio runtime sharing is asserted, not verified** (ARCH:244). napi-rs's `tokio` feature uses its own runtime; the mongodb crate spawns on the ambient runtime. Mixing them has historically caused "no reactor running" panics. T01 must compile a hello-world `#[napi] async fn` that calls a mongodb operation, or T09 is at risk.
- **`serde_json::Value` over the FFI for full result sets** (SPEC §5.2:208, ARCH §4.1) round-trips through one giant JSON allocation per query — exactly the opposite of the "cursor-based streaming, bounded memory" promise in NFR-1. For a 100k-row pre-agg build (T08 review:402), the Rust side buffers everything before napi serializes. Either: stream rows via an async iterator (napi-rs `AsyncIterator`/`Generator`), or document the buffering and bound it.

## IMPROVE

- **T12 is 2d and the largest TS task; it's underspecified.** "other dialect methods Cube relies on (verify against MysqlQuery source)" (PLAN:551) defers the actual scoping to the agent. Pre-enumerate the override list by diffing `MysqlQuery` against `BaseQuery` and put the count in the spec. Otherwise T12 will balloon and T13 (which depends on it) will surface dialect bugs late.
- **No cancellation story.** Cube can drop a query mid-flight; the plan never mentions `AbortSignal`/Tokio `CancellationToken` plumbing through napi. If Cube cancels, the cursor leaks until `max_time` fires. Add to T08/T09.
- **Schema-refresh task uses `Weak<MongoSqlClient>`** (ARCH:247) but T06 outputs (PLAN:296) take `Weak<SchemaCache>` — inconsistent. Pick one and make it match.
- **T18 prebuilt-binary CI listed as 1d** is wildly optimistic. napi-rs cross-compilation for `linux-arm64-musl` plus 6-platform matrix consistently takes multiple days of yak-shaving (cross toolchains, glibc pinning, code signing on darwin). Budget 2–3d.
- **CONTRIBUTING.md:222** says "Editing SPEC/ARCH without user agreement" is anti-pattern, but PLAN's Open Questions at :801–803 are SPEC-level. Process collision: agents will hit T04 and discover the SPEC's invented type names need correction. Add explicit "if SPEC contradicts upstream API, file Discovery and ask user" rule.
- **T11 review checklist:524** says "verify against base-driver source" but doesn't list the methods. `BaseDriver` in cube's master has ~25 methods; many have non-obvious defaults. Pre-list them.
- **No mention of `cube` driver registration** (`@cubejs-backend/server-core`'s `driverDependencies` map). Without it the driver loads via dynamic require but Cube's CLI/Docker won't auto-resolve. Add to T19 or T20.

## MISSING

- **License + IP review**: mongosql crate is SSPL (per the MongoDB repo). Linking SSPL into a driver published on npm under MIT/Apache (LICENSE file unread but typical) is not automatically OK. **This is the single biggest risk and gets zero treatment.** Talk to legal before T21.
- **`mongosql` crate maintenance signal**: no plan for what happens when MongoDB doesn't tag a release for 6 months, or breaks API. Pin strategy mentioned (SPEC §8) but no fork/vendoring fallback.
- **Connection pooling**: Cube creates one driver per data source but may instantiate multiple. The mongodb Rust crate has its own pool; the plan never says "one MongoSqlClient = one mongo client" or whether multiple Cube driver instances share. Document.
- **Resource lifetime on `release()`**: SPEC FR-1 says "stops background tasks" but T06's refresh task uses `Weak`-self-stop, which only fires on drop, not on `close()`. If Cube calls `release()` but holds a JS reference, the task keeps running. Need an explicit shutdown signal (Tokio `Notify` or `oneshot`).
- **napi-rs panic safety**: a panic in async Rust crashes the Node process. No `catch_unwind` boundary mentioned at the napi surface.
- **Observability is half-spec'd**: NFR-3 says "metrics emitted via tracing events" but no metric names, no histograms for query latency. Cube users will want a query-duration histogram day one.
- **Cube's third-party driver process**: CONTRIBUTING.md doesn't reference Cube's "Contributing Database Drivers" guide except as a SPEC link (SPEC:290). T20/T21 don't enumerate the actual upstream submission steps (PR to cube docs, `driverDependencies` in `@cubejs-backend/server-core`, smoke test by Cube maintainers). The "npm-first, then upstream" path is implicit, not planned.
- **AWS IAM auth tests**: SPEC FR-5 lists MONGODB-AWS as documented, but PLAN T17/T19 don't include an IAM-auth integration test (atlas-local doesn't speak IAM). The "tested in Atlas-only CI later" parenthetical (PLAN:281) is the only mention — no task owns it.
- **Determinism caveat for T07 snapshots**: PLAN:359 asserts "same input = same output bytes" for translation. mongosql output ordering is not necessarily stable across versions; snapshot tests on pipeline bytes will be brittle. Test on semantic equivalence (executable result), not bytes.

## TASK-LEVEL FLAGS

- **T01 (0.5d)** — bundles tsconfig + Cargo workspace + napi build hook + Makefile + sanity tests. Realistic only if scaffolding lifts from the napi-rs `package-template`. Otherwise 1d.
- **T03 review:182** says strip user/pass from `Display` but `ClientConfig.uri` is a single string. Either parse it or document that `Debug` redacts the whole field. As written, an agent will leak credentials in logs.
- **T04 (1d)** — depends on the unresolved Open Question at :801. Block until spike done.
- **T06 (1d)** — refresh-task lifecycle correctness (weak-pointer stop, no leak under 1000 swaps) is worth a peer review; mark `needs critic`. Also: tests that exercise concurrent reads under swap (loom or stress test) aren't called for and should be.
- **T07 (1d)** — snapshot of 10 SQL→pipeline assertions will rot the moment mongosql ships a new version. Flip to "translate then execute, assert result rows" — semantic, not syntactic.
- **T08 (1d)** — `bson_to_json` table omits `MinKey`/`MaxKey`/`Undefined` (legacy types). Cursor-batch test at 100k rows asserts no memory blowup but the `serde_json::Value::Array(rows)` return inherently buffers. Contradicts itself.
- **T09 (0.5d)** — too small. Wires the entire napi surface, including error mapping, async runtime hookup, and integration test against atlas-local. Bump to 1d.
- **T11 (1d)** — depends on `BaseDriver` method count being known; see IMPROVE. As written, an agent could implement only `query/testConnection/tablesSchema/release` and pass review while missing `informationSchemaQuery`, `getTablesQuery`, `downloadQueryResults`, `loadPreAggregationIntoTable`, etc. **Pre-enumerate the method list.**
- **T12 (2d)** — single largest task; risk of >128K context with all 20 snapshot tests, MongoSQL spec reading, and `MysqlQuery` source. Split into T12a (overrides + identifier/quoting/tz) and T12b (date arithmetic + intervals + seriesSql).
- **T13 (1d)** — fragile dependency on T12 being correct; "may edit MongoSqlQuery to fix dialect bugs" (PLAN:585) makes it a continuation of T12. Either fold into T12 or make it explicitly contingent.
- **T14–T17** — all gated on `make e2e` working in CI; T02's docker-compose health gates need to be rock-solid or every agent picks up flake. atlas-local image has a documented multi-minute boot for SQL Interface readiness; PLAN:135 says "doesn't sleep arbitrarily" but doesn't define the readiness probe.
- **T18 (1d)** — too small per IMPROVE.
- **T19 (1d)** — depends on Cube `v1.6.x` accepting a community-loaded driver via npm install. Cube's driver auto-resolution hits `driverDependencies`; community drivers historically need a `CUBEJS_DRIVER_PATH` workaround. Verify in spike before T19, or add the env var to SPEC §3.
- **T21 (0.5d)** — publishing 6-platform prebuilds + opening a Cube docs PR + smoke-testing fresh install is at minimum 1d, more if Cube's review is part of the loop.

## Most likely thing to go wrong that isn't called out as a risk

The `mongosql` crate either (a) isn't a usable public lib (SSPL + repo-only build), or (b) its public API doesn't match what SPEC/ARCH have invented for it. Either fully blocks T04+. The plan treats this as an Open Question (PLAN:801) when it's the project-defining risk. Spike it before T01 ships.

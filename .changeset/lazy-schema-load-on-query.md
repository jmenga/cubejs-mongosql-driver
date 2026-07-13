---
"@effectuate/cubejs-mongosql-driver": patch
---

Fix `query()` / `downloadQueryResults()` / `tablesSchema()` translating against an empty schema catalog when `testConnection()` hadn't primed it.

The native schema load + background refresh spawn used to run only inside `test_connection()`. A host (notably Cube's pre-aggregation refresh worker, `PreAggregationLoader.refreshReadOnlyExternalStrategy` → `driver.downloadQueryResults(...)`) that invoked a query path on a driver instance whose `testConnection()` had not run first translated against an empty catalog, so every translate failed with a misleading mongosql algebrize error (`Error 3008 ... cannot be resolved to any datasource`) rather than a real schema/data problem — crash-looping the pod.

The query paths now share the same `OnceCell`-guarded load via a new `ensure_schema_loaded()` in the native client, so they lazily prime the catalog (idempotent and race-safe) before translating. `test_connection()` remains the conventional priming step and additionally performs the bounded connectivity ping; it is no longer a precondition for querying. Applies to all `schemaSource` modes (`collection`, `file`, `atlas-sql`).

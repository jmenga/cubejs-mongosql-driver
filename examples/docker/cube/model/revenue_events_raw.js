// Pre-aggregation correctness equivalence harness — Gap 3 (HIGH).
//
// ==========================================================================
// !!! DRIFT WARNING — MUST STAY BYTE-EQUIVALENT TO `revenue_events.js` !!!
// ==========================================================================
// This file MUST mirror `examples/docker/cube/model/revenue_events.js`
// MODULO the `pre_aggregations` block — review BOTH files together on
// every change. The equivalence test in
// `tests/cube-e2e/cube-e2e.test.ts` ("pre-aggregation correctness
// equivalence (rollup-routed vs direct-against-source)") runs THE SAME
// LOGICAL QUERY against both cubes and asserts row-for-row equality.
// If the measures, dimensions, or `sql_table` drift, the equivalence
// test silently weakens (or starts comparing apples to oranges) and a
// real rollup-vs-source mismatch could slip through.
//
// We considered using Cube's `extends` feature to dedupe (the cube
// validator at `node_modules/@cubejs-backend/schema-compiler/dist/src/
// compiler/CubeValidator.js:851` accepts `extends: joi.func()`), but
// `extends` ALSO inherits `pre_aggregations` from the parent (per
// `CubeSymbols.js:130-140`: child's local pre-aggregations are merged
// WITH the parent's). That would silently re-introduce the rollup we
// want to bypass — defeating the entire purpose of this sibling cube.
// Copy-paste with this header comment is the safer pattern.
// ==========================================================================
//
// Mirrors `revenue_events.js` field-for-field but DROPS the
// `pre_aggregations` block. Same source collection (`revenue_events`),
// same measures, same dimensions — just no monthly rollup.
//
// Why: CubeJS's own `testQueries.ts` suite uses a sibling
// `customOrderDateNoPreAgg` dimension to bypass pre-aggregations and
// run the SAME logical query both through the materialized rollup AND
// directly against the source collection, asserting result equivalence.
// We mirror that contract here by issuing identical queries against
// `revenue_events` (rollup-routed) and `revenue_events_raw` (direct-
// against-source) and asserting row-for-row equality.
//
// A future bug in the rollup definition (wrong measure aggregation,
// missing dimension, off-by-one date partition) would produce
// divergent numbers between the two cubes — the equivalence test in
// `tests/cube-e2e/cube-e2e.test.ts` catches it.
//
// The two cubes share a source collection (`sql_table: 'revenue_events'`
// in both), so no extra `__sql_schemas` registration is needed —
// mongosql sees one underlying namespace and both cubes resolve to it.
cube('revenue_events_raw', {
  sql_table: 'revenue_events',

  measures: {
    count: { type: 'count' },
    totalAmount: { type: 'sum', sql: 'amount' },
  },

  dimensions: {
    accountId: { sql: 'account_id', type: 'string' },
    category: { sql: 'category', type: 'string' },
    occurredAt: { sql: 'occurred_at', type: 'time' },
  },

  // No pre_aggregations block — Cube routes every query directly to
  // the source. This is the canonical "no-rollup" reference.
});

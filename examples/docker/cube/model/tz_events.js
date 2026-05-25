// Cube model for the `tz_events` collection — timezone-boundary harness
// (Gap 7). See `tests/integration/fixtures/seed-data.js` for the seed.
//
// **Model-directory scope.** This file lives in `examples/docker/cube/model/`
// (used by the cube-e2e atlas-local setup). The atlas-sql variant under
// `examples/docker/cube/model-atlas-sql/` is a separate, smaller catalog
// pointing at the live Atlas SQL endpoint — do not edit there without
// updating this one too.
//
// The cube-e2e test (tests/cube-e2e/cube-e2e.test.ts → "non-UTC
// timezone") runs the same count-grouped-by-day query at `timezone:
// 'UTC'` and `timezone: 'Asia/Kolkata'` and pins the documented
// behavior. The driver's `convertTz` is a passthrough (UTC-only
// contract; see src/MongoSqlQuery.ts::convertTz), so the test
// documents what shape Cube emits when a non-UTC timezone is
// requested.
cube('tz_events', {
  sql_table: 'tz_events',

  measures: {
    count: { type: 'count' },
  },

  dimensions: {
    id: {
      sql: 'id',
      type: 'string',
      primary_key: true,
    },
    occurredAt: {
      sql: 'occurred_at',
      type: 'time',
    },
  },
});

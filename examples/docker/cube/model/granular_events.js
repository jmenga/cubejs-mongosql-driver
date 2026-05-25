// Cube model for the `granular_events` collection — time-granularity
// matrix harness (Gap 6). See `tests/integration/fixtures/seed-data.js`
// for the seed.
//
// **Model-directory scope.** This file lives in `examples/docker/cube/model/`
// (used by the cube-e2e atlas-local setup). The atlas-sql variant under
// `examples/docker/cube/model-atlas-sql/` is a separate, smaller catalog
// pointing at the live Atlas SQL endpoint — do not edit there without
// updating this one too.
//
// The cube-e2e test (tests/cube-e2e/cube-e2e.test.ts → "time-dimension
// granularity matrix") runs `count` grouped by every documented Cube
// granularity (`second/minute/hour/day/week/month/quarter/year`) over
// the seed and pins one expected bucket count per granularity.
cube('granular_events', {
  sql_table: 'granular_events',

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

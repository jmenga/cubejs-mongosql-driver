// Cube model for the `weird_types` collection — BSON type matrix
// harness (Gap 10). See `tests/integration/fixtures/seed-data.js`
// for the seed and `tests/integration/fixtures/seed-schemas.js` for the
// `__sql_schemas` entry.
//
// **Model-directory scope.** This file lives in `examples/docker/cube/model/`
// (used by the cube-e2e atlas-local setup). The atlas-sql variant under
// `examples/docker/cube/model-atlas-sql/` is a separate, smaller catalog
// pointing at the live Atlas SQL endpoint — do not edit there without
// updating this one too.
//
// The cube-e2e test pins:
//   - data_type annotation on each dimension matches the documented
//     Cube generic type (the driver maps mongosql `LONG` → `bigint`,
//     `BINDATA` → `text`, `TIMESTAMP` (BSON Timestamp) → `timestamp`,
//     `ARRAY` → `text`, `OBJECT` → `text` per src/native.ts type-name
//     mapping).
//   - representative value round-trips through /load (strings come back
//     as strings, numbers as numbers/strings depending on type).
//
// What this cube does NOT exercise: arithmetic / aggregation on the
// unusual types beyond `count`. Sum-on-Long is intentionally not
// declared here because the dialect emits the standard `SUM(id_long)`
// — that path is already covered by `orders.totalAmount` (decimal) and
// `revenue_events.totalAmount`. The Long-as-bigint round-trip below is
// what's new.
//
// Nested fields and array subscripts: mongosql v1.8.5 accepts
// document-path syntax (`nested.label`) — we already exercise the path
// in `configs.agentDisplayName`. We add `nested.count` here to pin the
// INT-shaped extraction, which differs from the configs string case.
// `tags[0]` (array subscript) is NOT covered as a dimension because
// mongosql v1.8.5's array subscript syntax requires a different
// projection path; we cover the array's existence indirectly via the
// `count` measure on the underlying collection.
cube('weird_types', {
  sql_table: 'weird_types',

  measures: {
    count: { type: 'count' },
    totalLong: { type: 'sum', sql: 'id_long' },
  },

  dimensions: {
    id: {
      sql: 'id',
      type: 'string',
      primary_key: true,
    },
    idLong: {
      sql: 'id_long',
      type: 'number', // Cube generic; mongosql column type LONG → bigint
    },
    // Nested-document field — string. Same shape as
    // `configs.agentDisplayName` but here every row has the field.
    nestedLabel: {
      sql: 'nested.label',
      type: 'string',
    },
    // Nested-document field — int. Pins the BSON Int32 round-trip via a
    // nested path (the configs harness only had a string nested path).
    nestedCount: {
      sql: 'nested.count',
      type: 'number',
    },
    occurredAt: {
      sql: 'occurred_at',
      type: 'time',
    },
    // BSON Binary subtype 0 — generic byte buffer. mongosql v1.8.5
    // surfaces BINDATA columns as opaque; we cast to STRING to round-trip
    // a printable form. Cube generic type 'string' is correct; the
    // cube-e2e test only pins that the dimension is queryable and
    // returns a non-empty string for the seeded rows. Hex/base64
    // representation depends on mongosql's BINDATA→STRING cast (BSON
    // canonical form: `BinData(0, "<base64>")`).
    binHex: {
      sql: 'CAST(`bin` AS string)',
      type: 'string',
    },
    // BSON Binary subtype 4 — UUID. mongosql treats subtype 4 the same
    // as subtype 0 at the SQL surface (no dedicated UUID column type at
    // v1.8.5). Same cast pattern as `binHex`.
    uuidStr: {
      sql: 'CAST(`uuid` AS string)',
      type: 'string',
    },
    // BSON Timestamp (replication-internal type, distinct from Date).
    // Cast to STRING for a stable wire representation. Cube generic
    // type 'string' rather than 'time' because the BSON Timestamp
    // semantics (oplog sequence number) don't map onto Cube's time
    // dimension expectations cleanly.
    tsTimestamp: {
      sql: 'CAST(`ts` AS string)',
      type: 'string',
    },
    // First element of the `tags` embedded array. mongosql v1.8.5
    // supports array subscript via `arr[0]` document-path syntax. Pins
    // that scalar-from-array projection works end-to-end.
    firstTag: {
      sql: 'tags[0]',
      type: 'string',
    },
  },
});

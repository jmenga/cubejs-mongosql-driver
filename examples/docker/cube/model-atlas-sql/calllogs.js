// Cube model for the Atlas SQL endpoint cube-e2e suite (overlay
// docker-compose.atlas-sql.yaml).
//
// Targets `calllogs` on the `dev-convo-hub` database — a real
// production-shape Atlas SQL collection whose schema is registered via
// `sqlGenerateSchema with setSchemas = true` (see
// metadata.description). The driver's atlas-sql mode discovers this
// collection by calling `sqlGetSchema` per name returned by
// `listCollections`.
//
// Column choices reflect the actual schema:
//   - `accountId` → string
//   - `status`    → string
//   - `callDuration` → int  (sum/avg measure)
//   - `createdAt` → date    (time dimension)
//
// The model is intentionally tiny — its job is to prove that the cube
// schema-compile pipeline routes through atlas-sql discovery end-to-end
// (cube → driver → sqlGetSchema → tablesSchema → /meta).
cube('calllogs', {
  sql_table: 'calllogs',

  measures: {
    count: { type: 'count' },
    totalDuration: { type: 'sum', sql: 'callDuration' },
  },

  dimensions: {
    accountId: {
      sql: 'accountId',
      type: 'string',
    },
    status: {
      sql: 'status',
      type: 'string',
    },
    createdAt: {
      sql: 'createdAt',
      type: 'time',
    },
  },
});

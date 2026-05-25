// Cube model for the `configs` collection — the sparse-nested-path
// regression harness. See `tests/integration/fixtures/seed-data.js`
// for the seed.
//
// Bug being pinned: mongosql's `$project` of `agent.displayName` OMITS
// the field on docs missing the source path; with `ORDER BY
// <nested-field> ASC` the sparse rows sort to row 0; Cube's native
// `getFinalQueryResult` compiles row→member extraction from row 0's
// keys and drops the column from every row. The driver's
// `normalizeRowShape` + `downloadQueryResults` types-list null-fill
// keep every row uniformly shaped so the sniff sees the column.
//
// The cube-e2e test (tests/cube-e2e/cube-e2e.test.ts) issues a /load
// query equivalent to the production `useAgentsList`:
// `dimensions: ['configs.id', 'configs.agentDisplayName']` with
// `order: { 'configs.agentDisplayName': 'asc' }`. Pre-fix, the response
// rows omit `configs.agentDisplayName` on every row; post-fix the
// populated 7 rows carry it as a string and the sparse 3 carry it as
// null.
cube('configs', {
  sql_table: 'configs',

  measures: {
    count: { type: 'count' },
  },

  dimensions: {
    id: {
      sql: 'id',
      type: 'string',
      primary_key: true,
    },
    // Document-path dimension — `agent.displayName` is the projection
    // that exposes the mongosql omit-on-missing behaviour. The dialect
    // emits `agent.displayName` verbatim (mongosql's document-path
    // syntax); the column lands in the row envelope as
    // `agent_display_name` after the driver flattens `$project`'s
    // empty-string envelope.
    agentDisplayName: {
      sql: 'agent.displayName',
      type: 'string',
    },
  },
});

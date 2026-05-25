// Cube model for the secondary-database `orders_secondary` collection.
// This cube is pinned to `data_source: 'secondary'` — Cube will invoke
// the cube.js `driverFactory(ctx)` with `ctx.dataSource === 'secondary'`,
// and our wiring returns a `MongoSqlDriver` configured to talk to the
// `mongosql_test_secondary` database instead of the default
// `mongosql_test`.
//
// Used by the multi-tenant Gap 8 cube-e2e test. The seed
// (`tests/integration/fixtures/seed-secondary-data.js`) puts 2 rows in
// `mongosql_test_secondary.orders_secondary`; the primary `orders` cube
// has 5 rows in `mongosql_test.orders`. The count delta is the visible
// proof that routing works.
//
// **Model-directory scope.** This file lives in `examples/docker/cube/model/`
// (used by the cube-e2e atlas-local setup). The atlas-sql variant under
// `examples/docker/cube/model-atlas-sql/` is a separate catalog; do not
// edit there without updating this one too.
cube('orders_secondary', {
  sql_table: 'orders_secondary',
  data_source: 'secondary',

  measures: {
    count: { type: 'count' },
    totalAmount: { type: 'sum', sql: 'amount' },
  },

  dimensions: {
    accountId: {
      sql: 'account_id',
      type: 'string',
    },
    status: {
      sql: 'status',
      type: 'string',
    },
    amount: {
      sql: 'amount',
      type: 'number',
    },
    createdAt: {
      sql: 'created_at',
      type: 'time',
    },
  },
});

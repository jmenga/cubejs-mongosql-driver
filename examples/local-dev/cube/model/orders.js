// Sample Cube model for local-dev. Queries the `orders` collection
// declared in ../../schema.yaml and seeded by ../../seed-data.js.
//
// Identifier convention (verified by tests/unit/dialect.test.ts:184):
// dimensions use BARE column SQL (`sql: 'account_id'`) — the
// MongoSqlQuery dialect's autoPrefixWithCubeName override strips the
// cube alias for single-cube queries, since mongosql v1.8.5 rejects
// `<table_alias>.<col>` in projection scope.
cube('orders', {
  sql_table: 'orders',

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
    createdAt: {
      sql: 'created_at',
      type: 'time',
    },
  },
});

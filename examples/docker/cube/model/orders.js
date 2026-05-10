// Sample Cube model against the integration-fixture `orders` collection
// (see ../../tests/integration/fixtures/seed-data.js for the seeded data).
//
// MongoSQL surfaces `orders` as a SQL table once a row exists in
// `__sql_schemas` for it — that's seeded by `seed-schemas.js` in the
// atlas-local container. The driver's MongoSqlQuery dialect emits
// MongoSQL-flavoured SQL (backtick quoting, `TIMESTAMP` for dates,
// `DATEADD/DATEDIFF/DATETRUNC` instead of `INTERVAL` arithmetic).
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

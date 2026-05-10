// Sample Cube model for local-dev. Queries the `orders` collection
// declared in ../../schema.yaml and seeded by ../../seed-data.js.
//
// To add a new dimension: add the field to schema.yaml, save, wait
// ~30 s for the driver to refresh, then add the entry here.
cube('orders', {
  sql_table: 'orders',

  measures: {
    count: { type: 'count' },
    totalAmount: { type: 'sum', sql: 'amount' },
    paidCount: {
      type: 'count',
      filters: [{ sql: `${CUBE}.status = 'paid'` }],
    },
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

  preAggregations: {
    // A simple monthly rollup. To exercise the partitioning + refresh
    // path documented in README → Pre-aggregations:
    //   1. Set CUBEJS_DB_QUERY_CACHE=false in compose to force re-build.
    //   2. Hit /cubejs-api/v1/load with totalAmount + accountId + month.
    //   3. Watch cube logs — you'll see DATEADD / DATETRUNC SQL emitted.
    monthlyByAccount: {
      measures: [count, totalAmount],
      dimensions: [accountId],
      timeDimension: createdAt,
      granularity: 'month',
      partitionGranularity: 'month',
      refreshKey: { every: '5 minute' },
    },
  },
});

// Payments cube — `shop_sales` data source.
//
// Exercises: time-dimension granularity (`month`), pre-agg with time
// dimension but no partitioning (vs Orders.dailyRevenue which is
// partitioned), `count_distinct` measure.
cube('Payments', {
  sql_table: 'payments',
  data_source: 'sales',

  joins: {
    Orders: {
      relationship: 'many_to_one',
      sql: `${CUBE}.order_id = ${Orders}._id`,
    },
  },

  measures: {
    count: { type: 'count' },
    totalCaptured: { type: 'sum', sql: 'amount' },
    avgPayment: { type: 'avg', sql: 'amount' },
    distinctOrders: { type: 'count_distinct', sql: 'order_id' },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    method: { sql: 'method', type: 'string' },
    capturedAt: { sql: 'captured_at', type: 'time' },
  },

  pre_aggregations: {
    byMethodMonthly: {
      measures: [Payments.count, Payments.totalCaptured, Payments.distinctOrders],
      dimensions: [Payments.method],
      time_dimension: Payments.capturedAt,
      granularity: 'month',
      refresh_key: { every: '1 hour' },
    },
  },
});

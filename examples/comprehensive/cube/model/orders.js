// Orders cube — `shop_sales` data source.
//
// Exercises: Decimal128 SUM (string-preserving), filtered measure
// (paidAmount), time dimension with daily granularity, partitioned +
// incremental pre-aggregation (`dailyRevenue`), `originalSql` pre-agg.
//
// Time-dimension SQL flows through MongoSqlQuery dialect overrides:
//   - timeStampCast → `CAST('...' AS TIMESTAMP)` (no `TIMESTAMP 'x'` literal)
//   - timeGroupedColumn → `DATETRUNC(<unit>, <col>)`
//   - subtractInterval/addInterval → `DATEADD(<unit>, <n>, <col>)`
cube('Orders', {
  sql_table: 'orders',
  data_source: 'sales',

  joins: {
    Customers: {
      relationship: 'many_to_one',
      sql: `${CUBE}.customer_id = ${Customers}._id`,
    },
    OrderItems: {
      relationship: 'one_to_many',
      sql: `${CUBE}._id = ${OrderItems}.order_id`,
    },
  },

  measures: {
    count: { type: 'count' },
    totalAmount: { type: 'sum', sql: 'amount' },
    avgAmount: { type: 'avg', sql: 'amount' },
    paidAmount: {
      type: 'sum',
      sql: 'amount',
      filters: [{ sql: `${CUBE}.status = 'paid'` }],
    },
    paidCount: {
      type: 'count',
      filters: [{ sql: `${CUBE}.status = 'paid'` }],
    },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    customerId: { sql: 'customer_id', type: 'string' },
    status: { sql: 'status', type: 'string' },
    currency: { sql: 'currency', type: 'string' },
    country: { sql: 'shipping_country', type: 'string' },
    createdAt: { sql: 'created_at', type: 'time' },
  },

  segments: {
    // Reusable filter — Cube emits the SQL inline at query time.
    onlyPaid: { sql: `${CUBE}.status = 'paid'` },
  },

  pre_aggregations: {
    // Plain rollup — no time dimension, no partitioning.
    byStatus: {
      measures: [Orders.count, Orders.totalAmount, Orders.paidCount],
      dimensions: [Orders.status, Orders.currency],
      refresh_key: { every: '1 hour' },
    },

    // Partitioned + incremental rollup — drives the DATETRUNC / DATEADD
    // override path. Cube materializes one CubeStore partition per month
    // and refreshes the latest partition incrementally.
    dailyRevenue: {
      measures: [Orders.count, Orders.totalAmount, Orders.paidAmount],
      dimensions: [Orders.status, Orders.country],
      time_dimension: Orders.createdAt,
      granularity: 'day',
      partition_granularity: 'month',
      // SQL refresh-key — re-evaluated against the SOURCE to decide if
      // a partition needs rebuild. Tests the cursor + decimal-coercion
      // path of the driver.
      refresh_key: {
        every: '1 hour',
        sql: `SELECT MAX(created_at) FROM orders`,
      },
      build_range_start: { sql: `SELECT CAST('2026-03-01T00:00:00Z' AS TIMESTAMP)` },
      build_range_end: { sql: `SELECT CAST('2026-04-30T23:59:59Z' AS TIMESTAMP)` },
    },
  },
});

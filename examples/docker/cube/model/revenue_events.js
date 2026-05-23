// Cube model for the multi-month `revenue_events` collection. This
// model exists exclusively to exercise the partitioned-rollup code
// path end-to-end (Critic v3 — Issue #2): a `partition_granularity:
// 'month'` pre-aggregation forces Cube Store to UNION 2+ materialized
// partitions when a query spans multiple months. Pre-fix, that UNION
// failed because the driver's `downloadQueryResults.types` came back
// as `text` for every aggregate column (the `any_of` resolution bug)
// and Cube Store rejected the column-type mismatch between partitions
// expecting `decimal`/`bigint` SUM/COUNT and the driver's `text`.
//
// The seed data spans 2026-01, 2026-02, and 2026-03 (see
// `tests/integration/fixtures/seed-data.js`), so the build_range below
// captures all three months and produces three partitions.

cube('revenue_events', {
  sql_table: 'revenue_events',

  measures: {
    count: { type: 'count' },
    totalAmount: { type: 'sum', sql: 'amount' },
  },

  dimensions: {
    accountId: { sql: 'account_id', type: 'string' },
    category: { sql: 'category', type: 'string' },
    occurredAt: { sql: 'occurred_at', type: 'time' },
  },

  pre_aggregations: {
    // Partitioned monthly rollup. With seed data in 2026-01..2026-03,
    // Cube materializes three partitions. A query covering the full
    // range UNIONs them — that's the regression harness.
    monthlyRevenue: {
      measures: [revenue_events.count, revenue_events.totalAmount],
      dimensions: [revenue_events.category],
      time_dimension: revenue_events.occurredAt,
      granularity: 'month',
      partition_granularity: 'month',
      refresh_key: {
        every: '1 hour',
        sql: `SELECT MAX(occurred_at) FROM revenue_events`,
      },
      build_range_start: { sql: `SELECT CAST('2026-01-01T00:00:00Z' AS TIMESTAMP)` },
      build_range_end: { sql: `SELECT CAST('2026-03-31T23:59:59Z' AS TIMESTAMP)` },
    },
  },
});

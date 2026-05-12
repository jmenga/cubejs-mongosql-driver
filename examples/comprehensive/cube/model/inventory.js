// InventorySnapshots cube — `shop_catalog` data source.
//
// Exercises: weekly granularity, partitioned pre-aggregation (weekly
// partitions, monthly compaction). 48 source rows is small, but the
// model shape is what production analytics teams use for daily inventory
// rollups.
cube('InventorySnapshots', {
  sql_table: 'inventory_snapshots',
  data_source: 'catalog',

  joins: {
    Products: {
      relationship: 'many_to_one',
      sql: `${CUBE}.product_id = ${Products}._id`,
    },
  },

  measures: {
    snapshotCount: { type: 'count' },
    totalQty: { type: 'sum', sql: 'qty_on_hand' },
    avgQty: { type: 'avg', sql: 'qty_on_hand' },
    distinctProducts: { type: 'count_distinct', sql: 'product_id' },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    productId: { sql: 'product_id', type: 'string' },
    warehouse: { sql: 'warehouse', type: 'string' },
    snapshotDate: { sql: 'snapshot_date', type: 'time' },
  },

  pre_aggregations: {
    weeklyByWarehouse: {
      measures: [
        InventorySnapshots.snapshotCount,
        InventorySnapshots.totalQty,
        InventorySnapshots.avgQty,
        InventorySnapshots.distinctProducts,
      ],
      dimensions: [InventorySnapshots.warehouse],
      time_dimension: InventorySnapshots.snapshotDate,
      granularity: 'week',
      partition_granularity: 'month',
      refresh_key: {
        every: '1 hour',
        sql: `SELECT MAX(snapshot_date) FROM inventory_snapshots`,
      },
      build_range_start: { sql: `SELECT CAST('2026-03-01T00:00:00Z' AS TIMESTAMP)` },
      build_range_end:   { sql: `SELECT CAST('2026-04-30T23:59:59Z' AS TIMESTAMP)` },
    },
  },
});

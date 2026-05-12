// OrderItems cube — `shop_sales` data source.
//
// Exercises: ObjectId-as-foreign-key (order_id), int + decimal measures,
// pre-aggregation tuned to be the LEFT side of the cross-data-source
// rollup_join. The `byProduct` rollup carries `productId` so the
// rollup_join in cross_source.js can pair it with Products.byCategory.
cube('OrderItems', {
  sql_table: 'order_items',
  data_source: 'sales',

  joins: {
    Orders: {
      relationship: 'many_to_one',
      sql: `${CUBE}.order_id = ${Orders}._id`,
    },
    // Cross-data-source join declaration — required by Cube's planner so
    // the rollup_join (below) knows the join shape (productId). The `sql`
    // references DIMENSIONS on both sides (not raw columns) because Cube
    // needs to map the join key into the rollup_join key resolution — and
    // dimension refs are what get carried into materialised rollups in
    // CubeStore. The expression is NEVER executed at the source level
    // (different databases); CubeStore evaluates it against the rollup rows.
    Products: {
      relationship: 'many_to_one',
      sql: `${CUBE.productId} = ${Products.id}`,
    },
  },

  measures: {
    itemCount: { type: 'count' },
    totalQty: { type: 'sum', sql: 'qty' },
    totalSubtotal: { type: 'sum', sql: 'subtotal' },
    avgPrice: { type: 'avg', sql: 'price' },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    orderId: { sql: 'order_id', type: 'string' },
    productId: { sql: 'product_id', type: 'string' },
  },

  pre_aggregations: {
    // Materialised view keyed by productId — left side of the cross-source
    // rollup_join below. Cube's rollup_join engine joins this in CubeStore
    // with Products.byCategory on productId.
    byProduct: {
      measures: [OrderItems.itemCount, OrderItems.totalQty, OrderItems.totalSubtotal],
      dimensions: [OrderItems.productId],
      indexes: {
        byProductId: {
          columns: [OrderItems.productId],
        },
      },
      refresh_key: { every: '1 hour' },
    },

    // CROSS-DATA-SOURCE rollup_join — pairs sales-DB OrderItems.byProduct
    // with catalog-DB Products.byCategory on productId.
    //
    // At query time, Cube:
    //   1. Routes each base rollup to its own MongoSqlDriver instance
    //      (per the driverFactory dispatch in cube.js).
    //   2. Materialises both rollups into CubeStore.
    //   3. Joins the rollups in CubeStore on productId — never crossing
    //      the database boundary in flight.
    //
    // Query it as: measures from OrderItems + dimensions from Products.
    revenueByCategory: {
      type: `rollup_join`,
      rollups: [OrderItems.byProduct, Products.byCategory],
      measures: [OrderItems.itemCount, OrderItems.totalSubtotal],
      dimensions: [Products.categoryId, Products.supplier],
      refresh_key: { every: '1 hour' },
    },
  },
});

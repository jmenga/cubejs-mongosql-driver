// Products cube — `shop_catalog` data source.
//
// Right side of the cross-data-source rollup_join: the `byCategory`
// rollup carries productId (the join key) + categoryId + supplier so the
// rollup_join can group revenue from `OrderItems.byProduct` (in the
// `shop_sales` DB) by category from THIS database.
cube('Products', {
  sql_table: 'products',
  data_source: 'catalog',

  joins: {
    Categories: {
      relationship: 'many_to_one',
      sql: `${CUBE}.category_id = ${Categories}._id`,
    },
  },

  measures: {
    count: { type: 'count' },
    avgListPrice: { type: 'avg', sql: 'list_price' },
    totalListPrice: { type: 'sum', sql: 'list_price' },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    name: { sql: 'name', type: 'string' },
    categoryId: { sql: 'category_id', type: 'string' },
    supplier: { sql: 'supplier', type: 'string' },
  },

  pre_aggregations: {
    bySupplier: {
      measures: [Products.count, Products.avgListPrice],
      dimensions: [Products.supplier],
      refresh_key: { every: '1 hour' },
    },

    // Right side of the cross-source rollup_join. Carries productId
    // (the join key) and categoryId so a query for "revenue by category"
    // can be answered entirely from materialized CubeStore data.
    //
    // The `indexes` clause is REQUIRED for rollup_join: Cube Store
    // refuses to execute a hash join without an index on the join key,
    // failing with "Can't find index to join table … on products__id".
    byCategory: {
      dimensions: [Products.id, Products.categoryId, Products.supplier],
      indexes: {
        byId: {
          columns: [Products.id],
        },
      },
      refresh_key: { every: '1 hour' },
    },
  },
});

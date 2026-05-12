// Categories cube — `shop_catalog` data source.
//
// Lookup table joined by Products. Self-join via `parent_id` is declared
// but not exercised in seed data (all categories are top-level).
cube('Categories', {
  sql_table: 'categories',
  data_source: 'catalog',

  measures: {
    count: { type: 'count' },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    name: { sql: 'name', type: 'string' },
    parentId: { sql: 'parent_id', type: 'string' },
  },
});

// Customers cube — `shop_sales` data source.
//
// Exercises: string primary key, time dim (signup_date), join to Orders
// (one-to-many), simple pre-aggregation.
cube('Customers', {
  sql_table: 'customers',
  data_source: 'sales',

  joins: {
    Orders: {
      relationship: 'one_to_many',
      sql: `${CUBE}._id = ${Orders}.customer_id`,
    },
  },

  measures: {
    count: { type: 'count' },
  },

  dimensions: {
    id: { sql: '_id', type: 'string', primary_key: true },
    name: { sql: 'name', type: 'string' },
    email: { sql: 'email', type: 'string' },
    tier: { sql: 'tier', type: 'string' },
    country: { sql: 'country', type: 'string' },
    signupDate: { sql: 'signup_date', type: 'time' },
  },

  pre_aggregations: {
    byTier: {
      measures: [Customers.count],
      dimensions: [Customers.tier, Customers.country],
      refresh_key: { every: '1 hour' },
    },
  },
});

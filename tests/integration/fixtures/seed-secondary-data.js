// Seed for the `mongosql_test_secondary` database — used by the
// `driverFactory(ctx)` multi-tenant test in cube-e2e (Gap 8).
//
// We deliberately use a DIFFERENT row count than the primary
// `mongosql_test.orders` collection so the cube-e2e test can prove
// routing by row-count delta alone — a query for
// `orders_secondary.count` against the secondary DB must return a
// value distinguishable from the same query routed to the primary.
//
// Idempotent — re-runs are no-ops via countDocuments() guards.

const db2 = db.getSiblingDB('mongosql_test_secondary');

if (db2.orders_secondary.countDocuments() === 0) {
  // 2 rows. Primary `orders` has 5 — a routed primary query would
  // return 5, secondary query returns 2; distinguishable.
  db2.orders_secondary.insertMany([
    {
      _id: ObjectId(),
      account_id: 'tenant_b_acct_1',
      amount: NumberDecimal('999.99'),
      status: 'paid',
      created_at: new Date('2026-03-01T12:00:00Z'),
    },
    {
      _id: ObjectId(),
      account_id: 'tenant_b_acct_2',
      amount: NumberDecimal('500.00'),
      status: 'pending',
      created_at: new Date('2026-03-05T09:30:00Z'),
    },
  ]);
}

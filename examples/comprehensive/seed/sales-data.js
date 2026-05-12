// Seed the `sales` MongoDB with: customers, orders, order_items, payments.
//
// Exercised MongoDB shapes:
//   - ObjectId primary keys (orders, order_items, payments).
//   - String primary keys (customers — cust_001..cust_004).
//   - Decimal128 monetary values (orders.amount, order_items.price/subtotal,
//     payments.amount) — string-preserving round-trip is asserted by the
//     comprehensive-example test queries.
//   - Date / TIMESTAMP columns (orders.created_at, customers.signup_date,
//     payments.captured_at) — drive time dimensions + partitioned pre-aggs.
//   - Nested documents (orders.shipping_address.{city,country,postal_code}).
//     The nested doc is included for realism; the Cube model surfaces
//     `shipping_country` at the top level to keep the SQL projection flat.
//   - Arrays of primitives (orders.tags) — declared in __sql_schemas for
//     schema completeness; not projected to Cube.
//
// Totals you can assert in queries (exact, by design):
//   count(orders)                         = 8
//   sum(amount) where status='paid'       = 1000.00
//   sum(amount) where status='pending'    = 150.00
//   sum(amount) where status='refunded'   = 50.00
//   sum(amount) overall                   = 1200.00
//   distinct customers                    = 4
//   orders by country: US=4, GB=2, AU=2
//   orders by month: 2026-03 = 4, 2026-04 = 4

const db = db.getSiblingDB('shop_sales');

if (db.customers.countDocuments() === 0) {
  db.customers.insertMany([
    {
      _id: 'cust_001',
      name: 'Alice Anderson',
      email: 'alice@example.com',
      tier: 'enterprise',
      country: 'US',
      signup_date: new Date('2025-09-12T00:00:00Z'),
    },
    {
      _id: 'cust_002',
      name: 'Bob Brown',
      email: 'bob@example.com',
      tier: 'pro',
      country: 'US',
      signup_date: new Date('2025-11-04T00:00:00Z'),
    },
    {
      _id: 'cust_003',
      name: 'Carol Clarke',
      email: 'carol@example.com',
      tier: 'pro',
      country: 'GB',
      signup_date: new Date('2025-07-21T00:00:00Z'),
    },
    {
      _id: 'cust_004',
      name: 'Dave Davies',
      email: 'dave@example.com',
      tier: 'free',
      country: 'AU',
      signup_date: new Date('2026-01-09T00:00:00Z'),
    },
  ]);
}

// Pre-create stable ObjectIds so order_items + payments can reference orders.
const ord = {
  o1: ObjectId('6a00000000000000000000a1'),
  o2: ObjectId('6a00000000000000000000a2'),
  o3: ObjectId('6a00000000000000000000a3'),
  o4: ObjectId('6a00000000000000000000a4'),
  o5: ObjectId('6a00000000000000000000a5'),
  o6: ObjectId('6a00000000000000000000a6'),
  o7: ObjectId('6a00000000000000000000a7'),
  o8: ObjectId('6a00000000000000000000a8'),
};

if (db.orders.countDocuments() === 0) {
  db.orders.insertMany([
    {
      _id: ord.o1,
      customer_id: 'cust_001',
      status: 'paid',
      amount: NumberDecimal('100.00'),
      currency: 'USD',
      created_at: new Date('2026-03-04T10:00:00Z'),
      shipping_country: 'US',
      shipping_address: { city: 'Boston', country: 'US', postal_code: '02108' },
      tags: ['priority', 'gift'],
    },
    {
      _id: ord.o2,
      customer_id: 'cust_001',
      status: 'paid',
      amount: NumberDecimal('200.00'),
      currency: 'USD',
      created_at: new Date('2026-03-18T11:30:00Z'),
      shipping_country: 'US',
      shipping_address: { city: 'Boston', country: 'US', postal_code: '02108' },
      tags: ['priority'],
    },
    {
      _id: ord.o3,
      customer_id: 'cust_002',
      status: 'paid',
      amount: NumberDecimal('300.00'),
      currency: 'USD',
      created_at: new Date('2026-03-25T14:00:00Z'),
      shipping_country: 'US',
      shipping_address: { city: 'Seattle', country: 'US', postal_code: '98101' },
      tags: [],
    },
    {
      _id: ord.o4,
      customer_id: 'cust_002',
      status: 'pending',
      amount: NumberDecimal('50.00'),
      currency: 'USD',
      created_at: new Date('2026-04-02T09:15:00Z'),
      shipping_country: 'US',
      shipping_address: { city: 'Seattle', country: 'US', postal_code: '98101' },
      tags: ['gift'],
    },
    {
      _id: ord.o5,
      customer_id: 'cust_003',
      status: 'paid',
      amount: NumberDecimal('400.00'),
      currency: 'GBP',
      created_at: new Date('2026-04-08T16:45:00Z'),
      shipping_country: 'GB',
      shipping_address: { city: 'London', country: 'GB', postal_code: 'SW1A 1AA' },
      tags: ['priority', 'wholesale'],
    },
    {
      _id: ord.o6,
      customer_id: 'cust_003',
      status: 'refunded',
      amount: NumberDecimal('25.00'),
      currency: 'GBP',
      created_at: new Date('2026-04-12T12:00:00Z'),
      shipping_country: 'GB',
      shipping_address: { city: 'London', country: 'GB', postal_code: 'SW1A 1AA' },
      tags: [],
    },
    {
      _id: ord.o7,
      customer_id: 'cust_004',
      status: 'pending',
      amount: NumberDecimal('100.00'),
      currency: 'AUD',
      created_at: new Date('2026-04-20T08:00:00Z'),
      shipping_country: 'AU',
      shipping_address: { city: 'Sydney', country: 'AU', postal_code: '2000' },
      tags: ['priority'],
    },
    {
      _id: ord.o8,
      customer_id: 'cust_004',
      status: 'refunded',
      amount: NumberDecimal('25.00'),
      currency: 'AUD',
      created_at: new Date('2026-04-28T17:30:00Z'),
      shipping_country: 'AU',
      shipping_address: { city: 'Sydney', country: 'AU', postal_code: '2000' },
      tags: [],
    },
  ]);
}

// order_items — denormalized line items for SQL-side joins. Each row has
// product_id, which is the join key used by the cross-source rollup_join
// to the catalog DB's products cube.
if (db.order_items.countDocuments() === 0) {
  db.order_items.insertMany([
    // o1 ($100): 1×prod_p1 @ $100 (electronics)
    { _id: ObjectId(), order_id: ord.o1, product_id: 'prod_p1', qty: 1, price: NumberDecimal('100.00'), subtotal: NumberDecimal('100.00') },
    // o2 ($200): 2×prod_p2 @ $100 (electronics)
    { _id: ObjectId(), order_id: ord.o2, product_id: 'prod_p2', qty: 2, price: NumberDecimal('100.00'), subtotal: NumberDecimal('200.00') },
    // o3 ($300): 1×prod_p3 @ $200 (books) + 1×prod_p1 @ $100 (electronics)
    { _id: ObjectId(), order_id: ord.o3, product_id: 'prod_p3', qty: 1, price: NumberDecimal('200.00'), subtotal: NumberDecimal('200.00') },
    { _id: ObjectId(), order_id: ord.o3, product_id: 'prod_p1', qty: 1, price: NumberDecimal('100.00'), subtotal: NumberDecimal('100.00') },
    // o4 ($50):  1×prod_p4 @ $50 (books)
    { _id: ObjectId(), order_id: ord.o4, product_id: 'prod_p4', qty: 1, price: NumberDecimal('50.00'), subtotal: NumberDecimal('50.00') },
    // o5 ($400): 4×prod_p5 @ $100 (home)
    { _id: ObjectId(), order_id: ord.o5, product_id: 'prod_p5', qty: 4, price: NumberDecimal('100.00'), subtotal: NumberDecimal('400.00') },
    // o6 ($25):  1×prod_p6 @ $25 (home)
    { _id: ObjectId(), order_id: ord.o6, product_id: 'prod_p6', qty: 1, price: NumberDecimal('25.00'), subtotal: NumberDecimal('25.00') },
    // o7 ($100): 1×prod_p2 @ $100 (electronics)
    { _id: ObjectId(), order_id: ord.o7, product_id: 'prod_p2', qty: 1, price: NumberDecimal('100.00'), subtotal: NumberDecimal('100.00') },
    // o8 ($25):  1×prod_p6 @ $25 (home)
    { _id: ObjectId(), order_id: ord.o8, product_id: 'prod_p6', qty: 1, price: NumberDecimal('25.00'), subtotal: NumberDecimal('25.00') },
  ]);
}

// payments — only on paid orders. Captured-at matches order created-at + 1h.
if (db.payments.countDocuments() === 0) {
  db.payments.insertMany([
    { _id: ObjectId(), order_id: ord.o1, amount: NumberDecimal('100.00'), method: 'card', captured_at: new Date('2026-03-04T11:00:00Z') },
    { _id: ObjectId(), order_id: ord.o2, amount: NumberDecimal('200.00'), method: 'card', captured_at: new Date('2026-03-18T12:30:00Z') },
    { _id: ObjectId(), order_id: ord.o3, amount: NumberDecimal('300.00'), method: 'bank', captured_at: new Date('2026-03-25T15:00:00Z') },
    { _id: ObjectId(), order_id: ord.o5, amount: NumberDecimal('400.00'), method: 'card', captured_at: new Date('2026-04-08T17:45:00Z') },
  ]);
}

print(
  `sales-data: shop_sales seeded — customers=${db.customers.countDocuments()}, ` +
    `orders=${db.orders.countDocuments()}, order_items=${db.order_items.countDocuments()}, ` +
    `payments=${db.payments.countDocuments()}`,
);

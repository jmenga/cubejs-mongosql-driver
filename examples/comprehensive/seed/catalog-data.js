// Seed the `catalog` MongoDB with: categories, products, inventory_snapshots.
//
// Verifiable totals:
//   count(products)                       = 6
//   sum(list_price)                       = 750.00
//   products by supplier: Acme=3, Beta=2, Gamma=1
//   products by category: electronics=2, books=2, home=2
//   count(inventory_snapshots)            = 48  (6 products × 8 weekly snapshots)

const db = db.getSiblingDB('shop_catalog');

if (db.categories.countDocuments() === 0) {
  db.categories.insertMany([
    { _id: 'cat_electronics', name: 'Electronics', parent_id: null },
    { _id: 'cat_books', name: 'Books', parent_id: null },
    { _id: 'cat_home', name: 'Home & Garden', parent_id: null },
  ]);
}

if (db.products.countDocuments() === 0) {
  db.products.insertMany([
    { _id: 'prod_p1', name: 'Wireless Headphones', category_id: 'cat_electronics', supplier: 'Acme', list_price: NumberDecimal('100.00') },
    { _id: 'prod_p2', name: 'Bluetooth Speaker',  category_id: 'cat_electronics', supplier: 'Acme', list_price: NumberDecimal('100.00') },
    { _id: 'prod_p3', name: 'SQL Cookbook',       category_id: 'cat_books',       supplier: 'Beta', list_price: NumberDecimal('200.00') },
    { _id: 'prod_p4', name: 'NoSQL Patterns',     category_id: 'cat_books',       supplier: 'Beta', list_price: NumberDecimal('50.00') },
    { _id: 'prod_p5', name: 'Cast Iron Pan',      category_id: 'cat_home',        supplier: 'Acme', list_price: NumberDecimal('100.00') },
    { _id: 'prod_p6', name: 'Garden Hose',        category_id: 'cat_home',        supplier: 'Gamma', list_price: NumberDecimal('200.00') },
  ]);
}

// 8 weekly snapshots × 6 products = 48 rows. Quantities are deterministic so
// totals are easy to verify in pre-agg tests.
const productIds = ['prod_p1', 'prod_p2', 'prod_p3', 'prod_p4', 'prod_p5', 'prod_p6'];
const warehouses = ['us-east', 'eu-west', 'apac'];
if (db.inventory_snapshots.countDocuments() === 0) {
  const snapshots = [];
  for (let week = 0; week < 8; week++) {
    const date = new Date(Date.UTC(2026, 2, 1 + week * 7));  // 2026-03-01 weekly
    productIds.forEach((pid, idx) => {
      snapshots.push({
        _id: ObjectId(),
        product_id: pid,
        warehouse: warehouses[idx % 3],
        snapshot_date: date,
        qty_on_hand: 100 - week * 5 + idx,  // 100..146-ish, deterministic
      });
    });
  }
  db.inventory_snapshots.insertMany(snapshots);
}

print(
  `catalog-data: shop_catalog seeded — categories=${db.categories.countDocuments()}, ` +
    `products=${db.products.countDocuments()}, snapshots=${db.inventory_snapshots.countDocuments()}`,
);

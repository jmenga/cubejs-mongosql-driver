# Comprehensive example — multi-data-source MongoDB + Cube

End-to-end demo of `mongosql-cubejs-driver` exercising every feature the
driver needs to support: rich BSON shapes, Cube joins, time dimensions,
partitioned + incremental pre-aggregations, segments, and — the headline
feature — **cross-data-source `rollup_join`** between two physically
separate MongoDB clusters.

## What's in the stack

```
                              cubejs/cube + mongosql-cubejs-driver
                                       (port 4000)
                                          │
              ┌───────────── driverFactory({ dataSource }) ──────────────┐
              │                                                          │
              ▼                                                          ▼
   MongoSqlDriver({ db: shop_sales })                MongoSqlDriver({ db: shop_catalog })
              │                                                          │
              ▼                                                          ▼
   ┌──────────────────────────┐                       ┌─────────────────────────────┐
   │ atlas-sales (port 27018) │                       │ atlas-catalog (port 27019)  │
   │   customers (4)          │                       │   categories (3)            │
   │   orders (8, Decimal128, │                       │   products (6, Decimal128)  │
   │     nested address,      │                       │   inventory_snapshots (48,  │
   │     array of tags)       │                       │     weekly × 6 products)    │
   │   order_items (9)        │                       └─────────────────────────────┘
   │   payments (4)           │
   └──────────────────────────┘
```

Two **separate** `atlas-local` containers so the `driverFactory` actually
runs two distinct `MongoSqlDriver` instances — one per database — and
the `rollup_join` materialises both rollups and joins them in CubeStore
without ever crossing the database boundary in flight.

## Files

```
examples/comprehensive/
├── README.md                  (this file)
├── docker-compose.yaml        (atlas-sales + atlas-catalog + cube)
├── seed/
│   ├── sales-data.js          (customers, orders, order_items, payments)
│   ├── sales-schemas.js       (__sql_schemas for shop_sales)
│   ├── catalog-data.js        (categories, products, inventory_snapshots)
│   └── catalog-schemas.js     (__sql_schemas for shop_catalog)
└── cube/
    ├── cube.js                (multi-source driverFactory + dialectFactory)
    └── model/
        ├── customers.js       (sales) — join to Orders, byTier rollup
        ├── orders.js          (sales) — filtered/avg measures, partitioned dailyRevenue
        ├── order_items.js     (sales) — byProduct rollup + revenueByCategory rollup_join
        ├── payments.js        (sales) — count_distinct, monthly time-dim pre-agg
        ├── categories.js      (catalog) — lookup
        ├── products.js        (catalog) — byCategory rollup (right side of rollup_join)
        └── inventory.js       (catalog) — weeklyByWarehouse partitioned pre-agg
```

## Quick start

```bash
# 1. Build the driver tarball (re-run after driver source changes).
./examples/docker/build-driver.sh

# 2. Build the Cube image (re-run after driver changes).
docker compose -f examples/docker/docker-compose.yaml build

# 3. Bring up the comprehensive stack (two atlas-local + cube).
docker compose -f examples/comprehensive/docker-compose.yaml up -d

# 4. Wait for cube readiness.
until curl -sf http://localhost:4000/readyz; do sleep 2; done

# 5. Open the Playground.
open http://localhost:4000
```

## Verifiable totals (so you can spot a regression)

Seed data is sized to make every aggregate easy to verify in Playground or
via `curl http://localhost:4000/cubejs-api/v1/load`.

| Query (Playground) | Expected result |
|---|---|
| `Orders.count` | 8 |
| `Orders.totalAmount` | 1200.00 |
| `Orders.paidAmount` (filtered measure) | 1000.00 |
| `Orders.count` by `Orders.status` | paid=4, pending=2, refunded=2 |
| `Orders.totalAmount` by `Customers.country` (cube join) | US=650, GB=425, AU=125 |
| `Products.totalListPrice` by `Products.supplier` | Acme=300, Beta=250, Gamma=200 |
| `InventorySnapshots.snapshotCount` × `warehouse` × week | 24 rows (8 weeks × 3 warehouses) |
| `OrderItems.totalSubtotal` × `Products.categoryId` (**rollup_join**) | electronics=500, books=250, home=450 |

The cross-source rollup_join total (500+250+450 = 1200) matches
`Orders.totalAmount` — sanity-check that the catalog-DB-keyed group-by
preserves the same revenue ground truth.

## Which feature each cube exercises

| Cube | Source | Driver / dialect feature exercised |
|---|---|---|
| `Customers` | `shop_sales` | String `_id`, time dim (signup_date), cube join to Orders |
| `Orders` | `shop_sales` | Decimal128 SUM (string-preserving), filtered measure `paidAmount`, segment `onlyPaid`, partitioned + time-bucketed pre-agg `dailyRevenue` (driver receives `WHERE created_at BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)` — parameter substitution path) |
| `OrderItems` | `shop_sales` | Cross-data-source join declaration to `Products`; `byProduct` rollup is the LEFT side of `rollup_join` |
| `Payments` | `shop_sales` | `count_distinct`, monthly granularity time-dim pre-agg |
| `Categories` | `shop_catalog` | Lookup cube — joined by Products |
| `Products` | `shop_catalog` | Decimal128 AVG, `byCategory` rollup (RIGHT side of `rollup_join`) with `indexes` on the join key |
| `InventorySnapshots` | `shop_catalog` | Time-series shape, partitioned weekly pre-agg with monthly compaction; refresh-key SQL `SELECT MAX(snapshot_date) FROM ...` |

## Sample queries to try in Playground

1. **Decimal128 round-trip**
   - Measures: `Orders.totalAmount`, `Orders.paidAmount`
   - Dimensions: `Orders.status`
   - Expected: paid=1000.00, pending=150.00 (paidAmount=0.00), refunded=50.00 (paidAmount=0.00). The decimal columns stay as `"1000.00"` strings end-to-end.

2. **Partitioned pre-agg hit**
   - Measures: `Orders.count`, `Orders.totalAmount`
   - Time dim: `Orders.createdAt`, granularity = month
   - Expected: 2 rows (March + April), each summing to 600.00.
   - Check the Playground "Performance" tab to confirm `Orders.dailyRevenue` was used.

3. **Cube join across cubes (same data source)**
   - Measures: `Orders.totalAmount`
   - Dimensions: `Customers.country`, `Customers.tier`
   - Expected: 4 rows totalling 1200.00.

4. **Cross-source `rollup_join` (the headline)**
   - Measures: `OrderItems.totalSubtotal`, `OrderItems.itemCount`
   - Dimensions: `Products.categoryId`, `Products.supplier`
   - Expected: 4 rows, totals: electronics-Acme=500, books-Beta=250, home-Gamma=50, home-Acme=400.
   - Watch the Performance tab — the load is served from
     `OrderItems.revenueByCategory` (the `rollup_join`) joining the two
     base rollups in CubeStore.

5. **Segment filter**
   - Measures: `Orders.count`, `Orders.totalAmount`
   - Segment: `Orders.onlyPaid`
   - Expected: 1 row — count=4, totalAmount=1000.00.

## Known limitations / where to push next

- **Atlas SQL Interface schema sampling** is mocked here — `__sql_schemas`
  is seeded via `seed/*-schemas.js` to mirror what the Atlas-managed
  sampler would write in production. Switch to a real Atlas cluster and
  the same model works unchanged.
- **No EXPORT_BUCKET** (no S3 UNLOAD equivalent in MongoDB). Pre-agg
  builds stream MQL results through the driver into CubeStore. Fine for
  this dataset; for hundreds-of-millions-of-rows pre-aggs, consider Path
  C from `DRIVER.md` (CDC → warehouse) instead.
- **Parameterised queries** are inlined client-side by the driver
  (mongosql v1.8.5 has no wire-level parameter protocol). This is
  transparent — Cube emits `WHERE col >= CAST(? AS TIMESTAMP)` with a
  values array, the driver substitutes the literal, mongosql translates
  the result. See `src/MongoSqlDriver.ts::substituteParameters`.
- **Cube model conventions:** every cube here uses BARE column SQL
  (e.g. `sql: 'status'`, not `sql: \`${CUBE}.status\``). The
  `MongoSqlQuery` dialect's `autoPrefixWithCubeName` override strips the
  cube alias on single-cube projections because mongosql rejects
  `<alias>.<col>` references in that scope (Error 3008). Cross-cube join
  expressions (`${CUBE.productId} = ${Products.id}`) reference
  DIMENSIONS, not raw columns — required by `rollup_join`'s join-graph
  resolution.

## Teardown

```bash
docker compose -f examples/comprehensive/docker-compose.yaml down -v
```

The `-v` is important — `atlas-local`'s replica-set bootstrap stores
keyfile state in the volume that, if reused with a different keyfile,
prevents the next start (`Unable to acquire security key`).

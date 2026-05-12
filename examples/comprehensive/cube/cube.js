/**
 * Cube configuration for the comprehensive example.
 *
 * Demonstrates Cube's multi-`dataSource` pattern: every cube in
 * `model/` declares `data_source: 'sales' | 'catalog'`, and the
 * `driverFactory` below returns a per-source MongoSqlDriver instance
 * bound to a different MongoDB database. Each driver maintains its
 * own __sql_schemas cache and translation context.
 *
 * Why explicit factories (vs Cube's auto-resolution from CUBEJS_DB_TYPE):
 *   1. Cube's default `dataSource: 'default'` path reads CUBEJS_DB_URI +
 *      CUBEJS_DB_NAME — fine for one source. For multiple sources we
 *      need to dispatch on `context.dataSource`.
 *   2. The default `dialectFactory` calls
 *      `lookupDriverClass(dbType).dialectClass()` and our typed driver
 *      exports `MongoSqlQuery` as a sibling rather than a static — so
 *      we wire the dialect class explicitly here too. The same dialect
 *      applies to every source because all sources speak MongoSQL.
 */
const { MongoSqlDriver, MongoSqlQuery } = require('mongosql-cubejs-driver');

const SOURCES = {
  sales: {
    uri: process.env.SALES_DB_URI,
    database: process.env.SALES_DB_NAME,
  },
  catalog: {
    uri: process.env.CATALOG_DB_URI,
    database: process.env.CATALOG_DB_NAME,
  },
};

module.exports = {
  driverFactory: ({ dataSource } = {}) => {
    const cfg = SOURCES[dataSource];
    if (!cfg) {
      // `default` is what Cube uses when a cube didn't set data_source —
      // we treat it as `sales` so any forgotten declaration still works.
      return new MongoSqlDriver({ uri: SOURCES.sales.uri, database: SOURCES.sales.database });
    }
    return new MongoSqlDriver(cfg);
  },
  dialectFactory: () => MongoSqlQuery,
};

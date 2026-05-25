/**
 * Cube configuration for the mongosql-cubejs-driver E2E example.
 *
 * Driver-name resolution (verified against
 * `@cubejs-backend/server-core@v1.6.44`'s
 * `src/core/DriverResolvers.ts::driverDependencies`):
 *
 *   The order of lookups is:
 *     1. closed `DriverDependencies` map — `mongosql` is NOT listed.
 *     2. `@cubejs-backend/${type}-driver` — we are not under that scope.
 *     3. `${type}-cubejs-driver` — our package is `mongosql-cubejs-driver`,
 *        which matches this convention (T19b rename eliminated the prior
 *        dual-install workaround).
 *
 *   With `CUBEJS_DB_TYPE=mongosql`, lookup (3) resolves to our package
 *   automatically. We still set `driverFactory` + `dialectFactory`
 *   explicitly because Cube's default `dialectFactory` calls
 *   `lookupDriverClass(ctx.dbType).dialectClass()` and our driver uses
 *   a separately-exported `MongoSqlQuery` class — wiring the dialect
 *   directly gives Cube the full type info without depending on a
 *   `dialectClass` static method on the driver. (Driver authors can
 *   alternatively expose `MongoSqlDriver.dialectClass = () =>
 *   MongoSqlQuery` and skip the dialectFactory override.)
 */
const { MongoSqlDriver, MongoSqlQuery } = require('mongosql-cubejs-driver');

// Resolve which Mongo database a request maps to based on the Cube
// `dataSource` configured on each cube model. This is the
// `driverFactory(ctx)` multi-tenant pattern from Cube's docs.
//
// - Cubes WITHOUT a `data_source:` (or `data_source: 'default'`) get
//   the primary driver — pulls database from `CUBEJS_DB_NAME` env.
// - Cubes WITH `data_source: 'secondary'` get a driver explicitly
//   pointed at `mongosql_test_secondary`.
//
// Cube caches one driver instance per `dataSource` name (per the
// `DriverFactoryByDataSource` contract in
// `@cubejs-backend/server-core/dist/src/core/RefreshScheduler.js`), so
// each branch is invoked once per process lifetime, not per query.
const DRIVER_FACTORY = (ctx) => {
  // Cube passes `{ dataSource }`; default to 'default' when not set.
  const ds = ctx?.dataSource || 'default';
  if (ds === 'secondary') {
    return new MongoSqlDriver({ database: 'mongosql_test_secondary' });
  }
  return new MongoSqlDriver({});
};

module.exports = {
  driverFactory: DRIVER_FACTORY,
  dialectFactory: () => MongoSqlQuery,
};

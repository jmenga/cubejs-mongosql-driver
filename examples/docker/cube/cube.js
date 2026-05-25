/**
 * Cube configuration for the @effectuate/cubejs-mongosql-driver E2E example.
 *
 * Driver-name resolution (verified against
 * `@cubejs-backend/server-core@v1.6.44`'s
 * `src/core/DriverResolvers.ts::driverDependencies`):
 *
 *   The order of lookups is:
 *     1. closed `DriverDependencies` map — `mongosql` is NOT listed.
 *     2. `@cubejs-backend/${type}-driver` — we are not under that scope.
 *     3. `${type}-cubejs-driver` — our package is now scoped
 *        (`@effectuate/cubejs-mongosql-driver`), so it does NOT match
 *        this convention either.
 *
 *   None of the auto-resolvers find the driver, so the explicit
 *   `driverFactory` + `dialectFactory` below are required (not just
 *   nice-to-have). They also short-circuit `OptsHandler`'s
 *   `lookupDriverClass(ctx.dbType).dialectClass()` path, which would
 *   otherwise throw "Unsupported db type: mongosql".
 */
const { MongoSqlDriver, MongoSqlQuery } = require('@effectuate/cubejs-mongosql-driver');

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

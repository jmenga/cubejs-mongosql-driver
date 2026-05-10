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

module.exports = {
  driverFactory: () => new MongoSqlDriver({}),
  dialectFactory: () => MongoSqlQuery,
};

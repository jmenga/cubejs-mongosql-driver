/**
 * Cube configuration for production Atlas with mongosql-cubejs-driver.
 *
 * With CUBEJS_DB_TYPE=mongosql and the driver installed under the
 * conventional name (`mongosql-cubejs-driver`), Cube auto-resolves the
 * driver via lookup path 3 in `@cubejs-backend/server-core`'s
 * `DriverResolvers.ts::driverDependencies` (`${type}-cubejs-driver`).
 *
 * No `driverFactory` / `dialectFactory` overrides are required — Cube
 * picks up `MongoSqlDriver` and its `MongoSqlQuery` dialect from the
 * package's exports automatically. Override only if you need to inject
 * config explicitly (per-tenant URIs, dynamic credentials, etc.).
 *
 * If you DO need overrides, this is the explicit form:
 *
 *   const { MongoSqlDriver, MongoSqlQuery } = require('mongosql-cubejs-driver');
 *   module.exports = {
 *     driverFactory: () => new MongoSqlDriver({}),
 *     dialectFactory: () => MongoSqlQuery,
 *   };
 *
 * For the auto-resolution path, an empty config is sufficient:
 */
module.exports = {
  // Cube is happy with an empty config; env vars do the work.
};

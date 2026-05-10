/**
 * Cube configuration for the cubejs-mongosql-driver E2E example.
 *
 * Driver-name resolution caveat (verified against
 * `@cubejs-backend/server-core@v1.6.44`'s
 * `src/core/DriverResolvers.ts::driverDependencies`):
 *
 *   The order of lookups is:
 *     1. closed `DriverDependencies` map — `mongosql` is NOT listed.
 *     2. `@cubejs-backend/${type}-driver` — we are not under that scope.
 *     3. `${type}-cubejs-driver` — our package is `cubejs-mongosql-driver`.
 *
 *   None match, so `CUBEJS_DB_TYPE=mongosql` would `throw new Error(
 *   'Unsupported db type: mongosql')`. We sidestep the lookup with both
 *   `driverFactory` AND `dialectFactory` overrides — Cube's default
 *   `dialectFactory` (in CubejsServerCore.ts) ALSO calls
 *   `lookupDriverClass(ctx.dbType).dialectClass()`, which would hit the
 *   same lookup path and throw. Overriding both is required for any
 *   driver whose package name doesn't match the conventions.
 *
 * Alternatives we considered and rejected:
 *   - Renaming the published package to `mongosql-cubejs-driver`. Breaks
 *     the napi-rs `optionalDependencies` block (T18) and the README
 *     install snippet (T20). Filed as a follow-up if zero-config install
 *     ever becomes a hard requirement.
 *   - Setting `CUBEJS_DRIVER_PATH=/path/to/...`. There is NO such env
 *     var in cube v1.6.44 — `DriverResolvers.ts` does not read it. The
 *     T19 task brief mentions this as a fallback, but reading the source
 *     shows it's unimplemented. `driverFactory` + `dialectFactory` is
 *     the only working mechanism.
 */
const { MongoSqlDriver, MongoSqlQuery } = require('cubejs-mongosql-driver');

module.exports = {
  driverFactory: () => new MongoSqlDriver({}),
  dialectFactory: () => MongoSqlQuery,
};

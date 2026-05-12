/**
 * Cube configuration for local-dev (file-mode schema).
 *
 * Same explicit driverFactory + dialectFactory pattern as the docker
 * example. The auto-resolution path (`module.exports = {}`) fails on
 * Cube v1.6.44 because the default `dialectFactory` invokes
 * `lookupDriverClass(dbType).dialectClass()`, and our typed driver
 * exports `MongoSqlQuery` as a sibling rather than a `dialectClass`
 * static — the lookup returns the module namespace, not a constructor.
 */
const { MongoSqlDriver, MongoSqlQuery } = require('mongosql-cubejs-driver');

module.exports = {
  driverFactory: () => new MongoSqlDriver({}),
  dialectFactory: () => MongoSqlQuery,
};

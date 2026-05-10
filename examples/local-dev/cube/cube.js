/**
 * Cube configuration for local-dev (file-mode schema).
 *
 * Same auto-resolution pattern as the production example —
 * `CUBEJS_DB_TYPE=mongosql` resolves the driver via the
 * `${type}-cubejs-driver` convention. No factory overrides needed
 * unless you want to inject config explicitly.
 */
module.exports = {};

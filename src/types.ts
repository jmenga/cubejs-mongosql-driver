/**
 * Public types for mongosql-cubejs-driver.
 * See SPEC.md §5.1 for the contract.
 */

/**
 * Driver schema-source discriminator.
 *
 * - `collection` — read `__sql_schemas` from the configured database.
 * - `file` — load YAML/JSON from `path` on disk.
 * - `atlas-sql` — enumerate collections via `listCollections` and call the
 *   Atlas SQL `sqlGetSchema` admin command per collection. Required for
 *   Atlas SQL endpoints (`*.a.query.mongodb.net`), which do not expose
 *   `__sql_schemas` as a queryable collection. See
 *   https://www.mongodb.com/docs/sql-interface/schema/view/
 */
export type SchemaSource = { kind: 'collection' } | { kind: 'file'; path: string } | { kind: 'atlas-sql' };

export interface MongoSqlConfig {
  /** MongoDB connection URI (mongodb:// or mongodb+srv://). */
  uri: string;
  /** Database to query. Also where __sql_schemas is read from in Collection mode. */
  database: string;
  /** Schema source. Defaults to { kind: 'collection' }. */
  schemaSource?: SchemaSource;
  /** Background refresh interval for schema cache, in seconds. Defaults to 300. */
  schemaRefreshSec?: number;
  /** If true, testConnection() succeeds even if initial schema load fails. Defaults to false. */
  schemaFailOpen?: boolean;
  /** Per-query timeout in milliseconds. Defaults to 60000. */
  queryTimeoutMs?: number;
  /** Max rows returned per query (buffered). Defaults to 100000. */
  maxRows?: number;
}

/**
 * Standard error codes thrown by the driver. See SPEC.md §6.
 */
export const ERROR_CODES = [
  'MONGOSQL_CONFIG_INVALID',
  'MONGOSQL_CONNECT_FAILED',
  'MONGOSQL_AUTH_FAILED',
  'MONGOSQL_SCHEMA_NOT_FOUND',
  'MONGOSQL_SCHEMA_INVALID',
  'MONGOSQL_SCHEMA_FILE_NOT_FOUND',
  'MONGOSQL_TRANSLATE_FAILED',
  'MONGOSQL_EXECUTE_FAILED',
  'MONGOSQL_TIMEOUT',
  'MONGOSQL_RESULT_TOO_LARGE',
  'MONGOSQL_CANCELLED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Error thrown by the driver. Always carries a `code` field. */
export interface MongoSqlError extends Error {
  code: ErrorCode;
}

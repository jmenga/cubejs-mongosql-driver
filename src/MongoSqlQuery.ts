/**
 * MongoSqlQuery — Cube SQL dialect for MongoSQL.
 * See SPEC.md FR-2 and ARCHITECTURE.md §2.1.
 *
 * Implementation arrives in T12 (forks from MysqlQuery / PostgresQuery in
 * @cubejs-backend/schema-compiler). For now, a stub class so MongoSqlDriver
 * compiles.
 */

export class MongoSqlQuery {
  // T12 will: extend BaseQuery, override quoteIdentifier, dateFormat,
  // convertTz, subtractInterval, addInterval, seriesSql, timeStampParam,
  // timeStampCast, dateTimeCast.
}

/**
 * MongoSqlQuery — Cube SQL dialect for MongoSQL.
 *
 * See SPEC.md FR-2 and ARCHITECTURE.md §4.1. Reference:
 * https://www.mongodb.com/docs/sql-interface/language-reference/
 *
 * T12a scope: STATIC SYNTAX — identifier quoting, type names, timestamp
 * casts, timezone passthrough, NULL/param tokens. T12b will cover date
 * arithmetic, intervals, seriesSql, dateBin, dateTimeFormat granularities.
 *
 * BaseQuery method-list audit (against
 * `node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js`,
 * cross-checked against `MysqlQuery.js` and `PostgresQuery.js`):
 *
 * | BaseQuery method                          | T12a action       | Why                                                                 |
 * |-------------------------------------------|-------------------|---------------------------------------------------------------------|
 * | escapeColumnName(name)                    | OVERRIDE          | Default emits double-quoted ident; MongoSQL uses backticks.         |
 * | quoteIdentifier(name)                     | ADD (alias)       | Not on BaseQuery, but task spec + driver doc-comment expect it.     |
 * | timeStampCast(value)                      | OVERRIDE          | Base emits `value::timestamptz` (Postgres). Mongosql has no `::`.   |
 * | dateTimeCast(value)                       | OVERRIDE          | Base emits `value::timestamp` (Postgres) — invalid in MongoSQL.     |
 * | timeStampParam(td)                        | INHERIT           | Default delegates to timeStampCast — fine once we override that.    |
 * | timestampFormat()                         | INHERIT           | ISO-8601 default matches mongosql's accepted CAST literal form.     |
 * | castToString(sql)                         | OVERRIDE          | Base emits `CAST(.. as TEXT)`; MongoSQL spells it `STRING`.         |
 * | convertTz(field)                          | OVERRIDE (passthr)| MongoSQL has no AT TIME ZONE / CONVERT_TZ; data is UTC. TODO T12b.  |
 * | inDbTimeZone(date)                        | INHERIT           | Pure JS — converts JS-side; no SQL emitted.                         |
 * | nowTimestampSql()                         | OVERRIDE          | Base emits `NOW()`; MongoSQL spells it `CURRENT_TIMESTAMP`.         |
 * | unixTimestampSql()                        | LEAVE (T12b)      | Base default uses EXTRACT/EPOCH — not in MongoSQL; defer with intvl.|
 * | concatStringsSql(strings)                 | INHERIT           | Default uses `||` template; MongoSQL accepts `||` for concat.       |
 * | sqlTemplates()                            | OVERRIDE (patch)  | Patch quotes/identifiers + types.* to MongoSQL spellings.           |
 * | timeGroupedColumn(g, dim)                 | LEAVE (T12b)      | Date-truncation; T12b — needs MongoSQL date funcs.                  |
 * | dateBin(interval, source, origin)         | LEAVE (T12b)      | Custom granularity; T12b.                                           |
 * | subtractInterval / addInterval            | LEAVE (T12b)      | Interval arithmetic — T12b.                                         |
 * | seriesSql(td)                             | LEAVE (T12b)      | Time-series UNION ALL — T12b.                                       |
 * | newParamAllocator(p)                      | INHERIT           | Default `?` placeholder works for MongoSQL.                         |
 * | escapeColumnName-driven preAggTableName   | INHERIT           | Inherited tableName logic produces backtick-safe identifiers.       |
 *
 * Anything not in this table is BaseQuery default behaviour and is either
 * (a) provably valid MongoSQL or (b) on the T12b list.
 */

import { BaseQuery } from '@cubejs-backend/schema-compiler';

// BaseQuery is loosely typed (constructor params are `any`); matching that here
// keeps the subclass shape compatible without leaking `any` into our public API.
type BaseQueryCompilers = ConstructorParameters<typeof BaseQuery>[0];
type BaseQueryOptions = ConstructorParameters<typeof BaseQuery>[1];

/**
 * Cube SQL-dialect adapter that emits MongoSQL-compatible SQL.
 *
 * Instantiated by `MongoSqlDriver.dialectClass()`. Cube calls into this for
 * every measure/dimension/timeDimension SQL fragment.
 */
export class MongoSqlQuery extends BaseQuery {
  public constructor(compilers: BaseQueryCompilers, options: BaseQueryOptions) {
    super(compilers, options);
  }

  /**
   * Identifier quoting — MongoSQL uses backticks.
   * Reference: https://www.mongodb.com/docs/sql-interface/language-reference/identifiers/
   *
   * BaseQuery's actual identifier-quoting hook is `escapeColumnName`; we
   * also expose `quoteIdentifier` as an alias because it's the conventional
   * name and the driver's audit comment refers to it.
   */
  public override escapeColumnName(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  public quoteIdentifier(identifier: string): string {
    return this.escapeColumnName(identifier);
  }

  /**
   * Timestamp literal cast — CRITICAL DISCOVERY (T07): MongoSQL does NOT
   * accept the SQL-92 `TIMESTAMP 'literal'` form. Use `CAST('...' AS TIMESTAMP)`.
   * Reference: https://www.mongodb.com/docs/sql-interface/language-reference/data-types/
   * (and crates/native/src/translate.rs::date_filter_emits_match_referencing_created_at)
   */
  public override timeStampCast(value: string): string {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  /**
   * datetime cast — MongoSQL has only `TIMESTAMP` (no separate `DATETIME` /
   * `DATE` types), so `dateTimeCast` and `timeStampCast` produce the same SQL.
   * SPEC FR-2 explicitly substitutes `TIMESTAMP` for `DATE`.
   */
  public override dateTimeCast(value: string): string {
    return `CAST(${value} AS TIMESTAMP)`;
  }

  /**
   * String cast — MongoSQL's string type is spelt `STRING`, not the SQL-92
   * `TEXT` (BaseQuery's default) or MySQL's `CHAR`.
   * Reference: https://www.mongodb.com/docs/sql-interface/language-reference/data-types/
   */
  public override castToString(sql: string): string {
    return `CAST(${sql} AS STRING)`;
  }

  /**
   * Generic typed cast helper. MongoSQL accepts the standard CAST grammar;
   * the *type name* must be one of MongoSQL's documented type tokens
   * (BOOL, INT, LONG, DOUBLE, DECIMAL, STRING, TIMESTAMP, ARRAY, DOCUMENT).
   *
   * Not currently a BaseQuery hook (BaseQuery emits CAST via the
   * `expressions.cast` template), but exposed for explicit use in T12b
   * date-arithmetic code paths and tests.
   */
  public castSqlType(value: string, type: string): string {
    return `CAST(${value} AS ${type})`;
  }

  /**
   * Timezone conversion — TODO(T12b): MongoSQL has no `AT TIME ZONE` or
   * `CONVERT_TZ` function. The Atlas SQL Language Reference documents
   * timezone via the `$dateAdd`/`$dateTrunc` aggregation expressions but no
   * standalone SQL function. Strategy: data is stored in UTC (BSON DateTime),
   * and `inDbTimeZone()` (inherited) shifts JS-side timestamp parameters.
   * For SQL-emitted field references we currently passthrough — this is
   * correct for UTC data and matches the "no conversion" semantics until a
   * proper hook is identified.
   *
   * If MongoSQL adds a timezone function later, swap this for the documented
   * form. The dialect test below documents the current behaviour so a future
   * change shows up as a test diff, not a silent regression.
   */
  public override convertTz(field: string): string {
    // TODO(T12b): emit MongoSQL timezone-aware form once one is identified.
    return field;
  }

  /**
   * NOW() equivalent. MongoSQL's documented form for the current time is
   * `CURRENT_TIMESTAMP` (SQL-92 keyword), not MySQL/Postgres `NOW()`.
   * Reference: https://www.mongodb.com/docs/sql-interface/language-reference/functions/
   */
  public override nowTimestampSql(): string {
    return 'CURRENT_TIMESTAMP';
  }

  /**
   * Patch the SQL templates that drive the rest of BaseQuery's builders.
   * Mirrors MysqlQuery.sqlTemplates()'s pattern of `super` + targeted
   * overrides. Only static-syntax fields are touched here; T12b will
   * augment this with date-function templates and time-series statements.
   */
  public override sqlTemplates(): ReturnType<BaseQuery['sqlTemplates']> {
    const templates = super.sqlTemplates();

    // Identifier quoting at the template layer (used by Cube's SQL planner).
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '``';

    // Type names — MongoSQL's spellings per the Language Reference.
    // https://www.mongodb.com/docs/sql-interface/language-reference/data-types/
    templates.types.string = 'STRING';
    templates.types.boolean = 'BOOL';
    templates.types.tinyint = 'INT';
    templates.types.smallint = 'INT';
    templates.types.integer = 'INT';
    templates.types.bigint = 'LONG';
    templates.types.float = 'DOUBLE';
    templates.types.double = 'DOUBLE';
    templates.types.decimal = 'DECIMAL';
    templates.types.timestamp = 'TIMESTAMP';
    // MongoSQL has no `DATE` / `TIME` / `INTERVAL` / `BINARY`; map to closest
    // representable type or delete to surface an error if Cube ever asks.
    templates.types.date = 'TIMESTAMP';
    templates.types.time = 'TIMESTAMP';
    delete templates.types.interval;
    delete templates.types.binary;

    return templates;
  }
}

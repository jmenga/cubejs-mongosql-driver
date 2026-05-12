/**
 * MongoSqlQuery — Cube SQL dialect for MongoSQL.
 *
 * See SPEC.md FR-2 and ARCHITECTURE.md §4.1. Reference:
 * https://www.mongodb.com/docs/sql-interface/language-reference/
 *
 * T12a scope: STATIC SYNTAX — identifier quoting, type names, timestamp
 * casts, timezone passthrough, NULL/param tokens.
 * T12b scope: DATE ARITHMETIC, INTERVALS, time-series generation,
 * date-truncation, dateBin, unixTimestampSql.
 *
 * MongoSQL date-function audit (verified against mongosql v1.8.5 source —
 * `mongosql/src/ast/definitions.rs` `FunctionName::try_from` and
 * `algebrize_date_function`, plus `ast/rewrites/test.rs`):
 *
 * | Function       | Signature                                              | Notes                                                              |
 * |----------------|--------------------------------------------------------|--------------------------------------------------------------------|
 * | DATEADD        | DATEADD(<date_part>, <numeric>, <date>)                | TIMESTAMPADD is an alias.                                          |
 * | DATEDIFF       | DATEDIFF(<date_part>, <start>, <end>[, <start_of_week>]) | Returns LONG. TIMESTAMPDIFF is an alias.                         |
 * | DATETRUNC      | DATETRUNC(<date_part>, <date>[, <start_of_week>])      | TIMESTAMPTRUNC is an alias.                                        |
 * | EXTRACT        | EXTRACT(<date_part> FROM <date>)                       | Supports YEAR/MONTH/WEEK/DAY/HOUR/MINUTE/SECOND/MILLISECOND/...    |
 * | YEAR/MONTH/... | YEAR(d), MONTH(d), ... — rewritten to EXTRACT          | All datepart helpers map to EXTRACT.                               |
 * | CURRENT_TIMESTAMP | CURRENT_TIMESTAMP[(<precision>)]                    | SQL-92 keyword. Replaces NOW().                                    |
 *
 * <date_part> for DATEADD / DATEDIFF / DATETRUNC must be one of:
 *   YEAR | QUARTER | MONTH | WEEK | DAY | HOUR | MINUTE | SECOND | MILLISECOND
 * (mongosql `DatePart` enum; `IsoWeek`/`DayOfYear` are EXTRACT-only and
 * panic for date-functions per `algebrize_date_function`.)
 *
 * NOT available in MongoSQL (called out so future maintainers don't try):
 *   - `INTERVAL '1 day'` literals — REJECTED by parser.
 *   - `EXTRACT(EPOCH FROM ...)` — EPOCH is not a `DatePart`.
 *   - `AT TIME ZONE` / `CONVERT_TZ` — no SQL-level timezone function.
 *   - `VALUES (...)` table constructors — no parser support.
 *   - `WITH RECURSIVE` / `generate_series` — no recursive CTEs.
 * For each gap, see the override below for the closest viable substitute.
 *
 * BaseQuery method-list audit (against
 * `node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js`,
 * cross-checked against `MysqlQuery.js` and `PostgresQuery.js`):
 *
 * | BaseQuery method                          | T12a/b action     | Why                                                                 |
 * |-------------------------------------------|-------------------|---------------------------------------------------------------------|
 * | escapeColumnName(name)                    | OVERRIDE (T12a)   | Default emits double-quoted ident; MongoSQL uses backticks.         |
 * | quoteIdentifier(name)                     | ADD (alias) (T12a)| Not on BaseQuery, but task spec + driver doc-comment expect it.     |
 * | autoPrefixWithCubeName(c, sql, isExpr)    | OVERRIDE (T19a)   | mongosql v1.8.5 rejects `<alias>.<col>` outside JOIN scope (3008).  |
 * | timeStampCast(value)                      | OVERRIDE (T12a)   | Base emits `value::timestamptz` (Postgres). Mongosql has no `::`.   |
 * | dateTimeCast(value)                       | OVERRIDE (T12a)   | Base emits `value::timestamp` (Postgres) — invalid in MongoSQL.     |
 * | timeStampParam(td)                        | INHERIT           | Default delegates to timeStampCast — fine once we override that.    |
 * | timestampFormat()                         | INHERIT           | ISO-8601 default matches mongosql's accepted CAST literal form.     |
 * | castToString(sql)                         | OVERRIDE (T12a)   | Base emits `CAST(.. as TEXT)`; MongoSQL spells it `STRING`.         |
 * | convertTz(field)                          | OVERRIDE (T12a)   | MongoSQL has no AT TIME ZONE / CONVERT_TZ. UTC-only passthrough.    |
 * | inDbTimeZone(date)                        | INHERIT           | Pure JS — converts JS-side; no SQL emitted.                         |
 * | nowTimestampSql()                         | OVERRIDE (T12a)   | Base emits `NOW()`; MongoSQL spells it `CURRENT_TIMESTAMP`.         |
 * | unixTimestampSql()                        | OVERRIDE (T12b)   | Base uses EXTRACT(EPOCH ...) — not in MongoSQL. Use DATEDIFF.       |
 * | concatStringsSql(strings)                 | INHERIT           | Default uses `||` template; MongoSQL accepts `||` for concat.       |
 * | sqlTemplates()                            | OVERRIDE (T12a)   | Patch quotes/identifiers + types.* to MongoSQL spellings.           |
 * | timeGroupedColumn(g, dim)                 | OVERRIDE (T12b)   | Use DATETRUNC. Week pinned to 'sunday' for determinism.             |
 * | dateBin(interval, source, origin)         | OVERRIDE (T12b)   | DATEADD(unit, FLOOR(DATEDIFF/N)*N, origin) — no INTERVAL literals.  |
 * | subtractInterval / addInterval            | OVERRIDE (T12b)   | DATEADD with positive/negative numeric. Compound = chained calls.   |
 * | intervalString(interval)                  | OVERRIDE (T12b)   | Quote-and-pass; no INTERVAL keyword. Used only in error/diag paths. |
 * | seriesSql(td)                             | OVERRIDE (T12b)   | UNION ALL of literal rows (MysqlQuery pattern, CAST not TIMESTAMP). |
 * | newParamAllocator(p)                      | INHERIT           | Default `?` placeholder works for MongoSQL.                         |
 * | escapeColumnName-driven preAggTableName   | INHERIT           | Inherited tableName logic produces backtick-safe identifiers.       |
 *
 * Anything not in this table is BaseQuery default behaviour and is either
 * (a) provably valid MongoSQL or (b) routed through the overrides above.
 */

import { BaseQuery } from '@cubejs-backend/schema-compiler';

/**
 * Inlined re-implementation of `@cubejs-backend/shared`'s `parseSqlInterval`.
 * The shared package isn't a direct dep (only transitive via schema-compiler),
 * and the function is a 10-line string-split — inlining avoids pulling in
 * the entire shared package and keeps the dialect's resolver-friendly.
 *
 * Source pattern (matches shared@1.6.44 `dist/src/time.js::parseSqlInterval`):
 *   "1 year 6 months" -> { year: 1, month: 6 }
 *   Negative values are supported.
 */
function parseSqlInterval(intervalStr: string): Record<string, number> {
  const out: Record<string, number> = {};
  const parts = intervalStr.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i += 2) {
    const value = parseInt(parts[i], 10);
    const unit = (parts[i + 1] ?? '').toLowerCase();
    if (!unit || Number.isNaN(value)) {
      throw new Error(`Cannot parse interval segment "${parts[i]} ${parts[i + 1] ?? ''}" in "${intervalStr}"`);
    }
    const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
    out[singular] = value;
  }
  return out;
}

/**
 * Map from Cube's lowercase granularity names to MongoSQL's documented
 * `DatePart` tokens (uppercase). Matches PostgresQuery's `GRANULARITY_TO_INTERVAL`
 * spirit but uses MongoSQL's spellings.
 */
const GRANULARITY_TO_DATE_PART: Readonly<Record<string, string>> = Object.freeze({
  second: 'SECOND',
  minute: 'MINUTE',
  hour: 'HOUR',
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  quarter: 'QUARTER',
  year: 'YEAR',
});

/**
 * Map from `parseSqlInterval` keys (singular, lowercase) to MongoSQL DATEADD
 * date-part tokens. Includes `millisecond` because mongosql DATEADD supports
 * MILLISECOND (per `DatePart` enum).
 */
const INTERVAL_UNIT_TO_DATE_PART: Readonly<Record<string, string>> = Object.freeze({
  millisecond: 'MILLISECOND',
  second: 'SECOND',
  minute: 'MINUTE',
  hour: 'HOUR',
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  quarter: 'QUARTER',
  year: 'YEAR',
});

/** A single component of a parsed Cube interval, mapped to MongoSQL units. */
export interface IntervalComponent {
  value: number;
  unit: string; // MongoSQL DatePart token, uppercase.
}

/**
 * BaseTimeDimension shape we depend on inside `seriesSql`. Cube's TS
 * declaration types `timeSeries()` as `string[][]` (loose), so we accept
 * the same and cast the inner row to a 2-tuple for safer destructuring.
 */
interface SeriesTimeDimension {
  timeSeries(): string[][];
}

/**
 * Cube SQL-dialect adapter that emits MongoSQL-compatible SQL.
 *
 * Instantiated by `MongoSqlDriver.dialectClass()`. Cube calls into this for
 * every measure/dimension/timeDimension SQL fragment.
 */
export class MongoSqlQuery extends BaseQuery {
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
   * Suppress the cube-alias prefix on bare column references when the query
   * has only one cube in scope.
   *
   * Background (T19 discovery): mongosql v1.8.5's algebrizer rejects qualified
   * `<table_alias>.<col>` references in projections when only one collection
   * is in scope — Error 3008 "Field `orders` in the `SELECT` clause at the 0
   * scope level not found". Cube's BaseQuery emits `${cubeAlias}.${sql}` for
   * every dimension that is a bare identifier (see BaseQuery.js:2508
   * `autoPrefixWithCubeName`), which makes every realistic Cube query against
   * a single cube fail translation.
   *
   * Strategy:
   *   - Single-cube query (`this.join.joins.length === 0`): drop the prefix
   *     — emit a bare column reference (`SELECT email FROM users`).
   *   - Multi-cube / JOIN: keep the prefix (`SELECT users.email`) — mongosql
   *     accepts qualified refs in JOIN scope (verified end-to-end in
   *     tests/integration/basic-queries.test.ts).
   *   - `this.join` may be `null` during pre-build / collect-cube-names paths
   *     before `prebuildJoin` runs; treat that as "not enough info, keep
   *     BaseQuery's behaviour" so we don't drop a prefix Cube actually needed.
   *   - `isMemberExpr` (member-expression SQL) bypasses the prefix entirely
   *     in BaseQuery; keep that semantics for forward compat.
   *
   * The conditional fall-through to `super` keeps every other code path
   * (non-bare expressions like `LOWER(email)` already escape the regex match
   * and are returned verbatim by the base implementation) unchanged.
   */
  public override autoPrefixWithCubeName(cubeName: string, sql: string, isMemberExpr = false): string {
    // Single-cube projection: mongosql rejects `<alias>.<col>`. Strip the
    // alias prefix only when (a) we'd otherwise emit it (bare identifier,
    // not a member-expression) and (b) the query truly has no joins.
    const join: { joins: unknown[] } | null | undefined = (this as unknown as { join?: { joins: unknown[] } | null })
      .join;
    if (
      join &&
      Array.isArray(join.joins) &&
      join.joins.length === 0 &&
      !isMemberExpr &&
      /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(sql)
    ) {
      return sql;
    }
    return super.autoPrefixWithCubeName(cubeName, sql, isMemberExpr);
  }

  /**
   * GROUP BY by column alias instead of positional `1, 2, ...`.
   * mongosql v1.8.5's algebrizer rejects positional refs in GROUP BY
   * (and the failure mode misreports as Error 3008 "Field <col> in the
   * SELECT clause not found"). Mirrors the ClickHouseQuery pattern.
   */
  public override groupByClause(): string {
    if ((this as unknown as { ungrouped?: boolean }).ungrouped) {
      return '';
    }
    const aliases = (this as unknown as { dimensionAliasNames(): string[] }).dimensionAliasNames();
    return aliases.length ? ` GROUP BY ${aliases.join(', ')}` : '';
  }

  /**
   * ORDER BY by column alias instead of positional `1, 2, ...`.
   * Same constraint as `groupByClause` — mongosql requires named refs.
   */
  public override orderHashToString(hash: { id: string; desc: boolean } | null | undefined): string | null {
    if (!hash || !hash.id) {
      return null;
    }
    const fieldAlias = (this as unknown as { getFieldAlias(id: string): string | null }).getFieldAlias(hash.id);
    if (fieldAlias === null) {
      return null;
    }
    const direction = hash.desc ? 'DESC' : 'ASC';
    return `${fieldAlias} ${direction}`;
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
   */
  public castSqlType(value: string, type: string): string {
    return `CAST(${value} AS ${type})`;
  }

  /**
   * Timezone conversion — MongoSQL has no `AT TIME ZONE` or `CONVERT_TZ`
   * function (verified against the v1.8.5 grammar). Data is stored in UTC
   * (BSON DateTime), and `inDbTimeZone()` (inherited) shifts JS-side
   * timestamp parameters. For SQL-emitted field references we passthrough —
   * correct for UTC data and matching "no conversion" semantics.
   *
   * Revisit if MongoSQL adds a timezone-aware function form, or if T14
   * integration shows non-UTC dimensions break.
   */
  public override convertTz(field: string): string {
    return field;
  }

  /**
   * NOW() equivalent. MongoSQL's documented form for the current time is
   * `CURRENT_TIMESTAMP` (SQL-92 keyword), not MySQL/Postgres `NOW()`.
   */
  public override nowTimestampSql(): string {
    return 'CURRENT_TIMESTAMP';
  }

  /**
   * Seconds since the Unix epoch. BaseQuery default uses
   * `EXTRACT(EPOCH FROM NOW())`, but MongoSQL's `EXTRACT` does NOT support
   * the `EPOCH` date-part (only YEAR/MONTH/WEEK/DAY/HOUR/MINUTE/SECOND/
   * MILLISECOND/DAYOFYEAR/DAYOFWEEK/ISOWEEK/ISOWEEKDAY — see
   * `algebrize_extract` in mongosql/src/algebrizer/definitions.rs).
   *
   * Use `DATEDIFF(SECOND, '1970-01-01T00:00:00Z', CURRENT_TIMESTAMP)`
   * instead. Returns LONG (mongosql `$dateDiff`).
   */
  public override unixTimestampSql(): string {
    return `DATEDIFF(SECOND, ${this.timeStampCast("'1970-01-01T00:00:00Z'")}, ${this.nowTimestampSql()})`;
  }

  /**
   * Parse a Cube/Postgres-style interval string ("1 day", "2 weeks",
   * "1 year 6 months") into an ordered list of MongoSQL DATEADD components.
   *
   * Cube emits compound intervals for partition ranges and granularity
   * offsets. MongoSQL's DATEADD takes a single `<date_part>`, so we apply
   * each component as a chained DATEADD call (see `addInterval` /
   * `subtractInterval`). Order is preserved from `parseSqlInterval` so the
   * outermost DATEADD is the *last* component (matches semantics: applying
   * `(YEAR, 1)` then `(MONTH, 6)` is equivalent to "1 year 6 months").
   *
   * Public for unit-testing the bridge in isolation; not on BaseQuery.
   */
  public intervalUnitsForMongo(interval: string): IntervalComponent[] {
    const parsed = parseSqlInterval(interval) as Record<string, number>;
    const components: IntervalComponent[] = [];
    for (const [unit, value] of Object.entries(parsed)) {
      const datePart = INTERVAL_UNIT_TO_DATE_PART[unit];
      if (!datePart) {
        throw new Error(`MongoSQL DATEADD does not support interval unit "${unit}" (from "${interval}")`);
      }
      components.push({ value, unit: datePart });
    }
    if (components.length === 0) {
      throw new Error(`Cannot parse interval "${interval}" — produced no components`);
    }
    return components;
  }

  /**
   * Add a Cube interval to a date expression. Compound intervals
   * ("1 year 6 months") are emitted as chained DATEADD calls.
   *
   * MongoSQL has no `INTERVAL '...'` literal. The base implementation emits
   * `${date} + interval '...'` which the parser rejects.
   */
  public override addInterval(date: string, interval: string): string {
    return this.applyIntervalChain(date, this.intervalUnitsForMongo(interval), 1);
  }

  /**
   * Subtract a Cube interval from a date expression. Implemented as DATEADD
   * with negated values (so `subtractInterval('d', '1 month')` becomes
   * `DATEADD(MONTH, -1, d)`). Compound intervals chain the same way as
   * `addInterval`.
   */
  public override subtractInterval(date: string, interval: string): string {
    return this.applyIntervalChain(date, this.intervalUnitsForMongo(interval), -1);
  }

  private applyIntervalChain(date: string, components: IntervalComponent[], sign: 1 | -1): string {
    return components.reduce((acc, { value, unit }) => `DATEADD(${unit}, ${sign * value}, ${acc})`, date);
  }

  /**
   * Printable interval string. MongoSQL has no INTERVAL literal so this is
   * not safe to splice into emitted SQL — kept for diagnostic / error
   * messages and for any BaseQuery code path we haven't audited yet (a
   * future grep for `'1 day'` in SQL output would surface a regression).
   */
  public override intervalString(interval: string): string {
    return `'${interval}'`;
  }

  /**
   * Truncate a timestamp to a granularity boundary. MongoSQL's documented
   * form is `DATETRUNC(<unit>, <date>[, <start_of_week>])`. For week we pin
   * `'sunday'` explicitly: mongosql's `ScalarFunctionsRewritePass` defaults
   * a missing third arg to `'sunday'` (per ast/rewrites/test.rs::
   * `timestamp_trunc`), but Cube's tests should not depend on that
   * implicit default — a future mongosql release could change it.
   */
  public override timeGroupedColumn(granularity: string, dimension: string): string {
    const datePart = GRANULARITY_TO_DATE_PART[granularity];
    if (!datePart) {
      throw new Error(`MongoSQL dialect does not support granularity "${granularity}"`);
    }
    if (granularity === 'week') {
      return `DATETRUNC(${datePart}, ${dimension}, 'sunday')`;
    }
    return `DATETRUNC(${datePart}, ${dimension})`;
  }

  /**
   * Bucket `source` into intervals starting from `origin`. Cube uses this
   * for custom (non-natural) granularities like "5 minutes" or "10 days".
   *
   * MongoSQL has no INTERVAL literal, so PostgresQuery's
   * `'origin'::ts + INTERVAL N * FLOOR(EXTRACT(EPOCH ...))` form doesn't
   * port. Instead we use the DATEADD/DATEDIFF identity:
   *
   *   floor((source - origin) / interval) * interval + origin
   *
   * which becomes:
   *
   *   DATEADD(unit, FLOOR(DATEDIFF(unit, origin, source) / N) * N, origin)
   *
   * Year and quarter intervals are normalised to MONTH (1 year = 12 months,
   * 1 quarter = 3 months) so arithmetic doesn't depend on leap-day-aware
   * second math. Every other unit (week / day / hour / minute / second /
   * millisecond) is used as-is — DATEDIFF/DATEADD operate in the unit's
   * native granularity which is the most precise viable choice.
   *
   * NOTE: only single-component intervals are supported here (matches
   * Cube's custom-granularity inputs which are always one unit). Compound
   * dateBin intervals would need a different strategy.
   */
  public override dateBin(interval: string, source: string, origin: string): string {
    const components = this.intervalUnitsForMongo(interval);
    if (components.length !== 1) {
      throw new Error(`MongoSQL dateBin requires a single-unit interval; got "${interval}"`);
    }
    const [{ value, unit }] = components;
    // Normalise year/quarter to MONTH so the unit aligns with calendar
    // boundaries; everything else uses its native unit for max precision.
    const usedUnit = unit === 'YEAR' || unit === 'QUARTER' ? 'MONTH' : unit;
    const stride = unit === 'YEAR' ? value * 12 : unit === 'QUARTER' ? value * 3 : value;
    const originExpr = this.dateTimeCast(`'${origin}'`);
    return `DATEADD(${usedUnit}, FLOOR(DATEDIFF(${usedUnit}, ${originExpr}, ${source}) / ${stride}) * ${stride}, ${originExpr})`;
  }

  /**
   * Generate the date-series SQL Cube uses for time-bucketed pre-aggregations.
   * MongoSQL has no `VALUES (...)`, no recursive CTE, and no `generate_series`,
   * so we emit a UNION ALL of literal-row SELECTs (MysqlQuery's strategy)
   * and CAST in the outer projection. Identical row count to MysqlQuery's
   * version; the difference is `CAST(... AS TIMESTAMP)` instead of
   * MySQL-specific `TIMESTAMP(...)`.
   *
   * NOTE: emits N rows for an N-row series. For very large partition ranges
   * Cube can pre-compute the row set in JS — there's no in-DB way to grow
   * the series without recursive CTEs, which v1.8.5 doesn't support.
   */
  public override seriesSql(timeDimension: SeriesTimeDimension): string {
    const rows = timeDimension.timeSeries();
    const union = rows
      .map((row) => {
        const [from, to] = row;
        return `SELECT '${from}' f, '${to}' t`;
      })
      .join(' UNION ALL ');
    const dateFrom = this.escapeColumnName('date_from');
    const dateTo = this.escapeColumnName('date_to');
    return `SELECT CAST(dates.f AS TIMESTAMP) AS ${dateFrom}, CAST(dates.t AS TIMESTAMP) AS ${dateTo} FROM (${union}) ${this.asSyntaxTable} dates`;
  }

  /**
   * Patch the SQL templates that drive the rest of BaseQuery's builders.
   * Mirrors MysqlQuery.sqlTemplates()'s pattern of `super` + targeted
   * overrides.
   *
   * T12b additions: remove the `expressions.interval` template (BaseQuery's
   * default emits `INTERVAL '<x>'` — invalid MongoSQL) so any caller that
   * tries to render an interval literal surfaces an error rather than
   * silently emitting unparseable SQL. The arithmetic-emitting paths
   * (subtractInterval/addInterval/dateBin) don't go through this template.
   * Also drop `statements.generated_time_series_*` for the same reason —
   * those are recursive-CTE forms that mongosql doesn't accept.
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

    // Drop INTERVAL-literal and recursive-CTE forms — mongosql v1.8.5
    // rejects both. Anything that would have used these now routes through
    // our typed overrides (addInterval/subtractInterval/seriesSql) or
    // surfaces a clear missing-template error.
    if (templates.expressions) {
      delete templates.expressions.interval;
    }
    if (templates.statements) {
      delete templates.statements.generated_time_series_select;
      delete templates.statements.generated_time_series_with_cte_range_source;
    }

    return templates;
  }
}

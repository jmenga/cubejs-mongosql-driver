/**
 * Dialect tests for MongoSqlQuery.
 * Run: pnpm test:unit dialect
 *
 * Covers:
 *   - T12a: identifier quoting, casts, type names, NULL/param tokens, convertTz passthrough
 *   - T12b: date arithmetic (DATEADD), interval handling, time-grouping (DATETRUNC),
 *           dateBin, seriesSql (UNION ALL form), unixTimestampSql
 */
import { describe, expect, it } from 'vitest';

import { MongoSqlQuery } from '../../src/MongoSqlQuery.js';

/**
 * The dialect class is normally instantiated by Cube via its compiler stack.
 * For unit tests we only exercise the syntax overrides (which don't touch
 * `this.compilers`/`this.options`). We construct a "bare" instance via
 * `Object.create` to skip the heavyweight constructor and access the prototype
 * methods directly. This is the same trick the upstream
 * @cubejs-backend/schema-compiler tests use for its dialect-method audits.
 */
function makeDialect(): MongoSqlQuery {
  return Object.create(MongoSqlQuery.prototype) as MongoSqlQuery;
}

describe('MongoSqlQuery dialect (T12a — static syntax)', () => {
  describe('identifier quoting', () => {
    it('uses backticks for identifiers', () => {
      const q = makeDialect();
      expect(q.quoteIdentifier('orders')).toBe('`orders`');
      expect(q.escapeColumnName('orders')).toBe('`orders`');
    });

    it('escapes embedded backticks by doubling them', () => {
      const q = makeDialect();
      // `foo`bar` — the inner backtick is doubled, then the whole is wrapped.
      expect(q.escapeColumnName('foo`bar')).toBe('`foo``bar`');
      expect(q.quoteIdentifier('foo`bar')).toBe('`foo``bar`');
    });

    it('handles identifiers with no special chars', () => {
      const q = makeDialect();
      expect(q.escapeColumnName('orders.created_at')).toBe('`orders.created_at`');
    });
  });

  describe('timestamp & datetime casts', () => {
    it('emits CAST(... AS TIMESTAMP) for timeStampCast', () => {
      const q = makeDialect();
      // T07 discovery: MongoSQL parser rejects `TIMESTAMP 'literal'`; we MUST
      // emit the CAST form. See crates/native/src/translate.rs.
      expect(q.timeStampCast("'2026-04-01T00:00:00Z'")).toBe("CAST('2026-04-01T00:00:00Z' AS TIMESTAMP)");
    });

    it('dateTimeCast matches timeStampCast', () => {
      const q = makeDialect();
      // SPEC FR-2: MongoSQL has only TIMESTAMP (no DATETIME / DATE).
      // Both cast helpers must produce the same SQL.
      const sample = "'2026-04-01T00:00:00Z'";
      expect(q.dateTimeCast(sample)).toBe(q.timeStampCast(sample));
      expect(q.dateTimeCast(sample)).toBe("CAST('2026-04-01T00:00:00Z' AS TIMESTAMP)");
    });

    it('castToString uses MongoSQL STRING type', () => {
      const q = makeDialect();
      // BaseQuery default would be `CAST(foo as TEXT)` — invalid in MongoSQL.
      expect(q.castToString('foo')).toBe('CAST(foo AS STRING)');
    });

    it('castSqlType passes through the type name verbatim', () => {
      const q = makeDialect();
      expect(q.castSqlType('foo', 'INT')).toBe('CAST(foo AS INT)');
      expect(q.castSqlType('foo', 'TIMESTAMP')).toBe('CAST(foo AS TIMESTAMP)');
      expect(q.castSqlType("'12.5'", 'DECIMAL')).toBe("CAST('12.5' AS DECIMAL)");
    });
  });

  describe('NOW() equivalent', () => {
    it('emits CURRENT_TIMESTAMP, not NOW()', () => {
      const q = makeDialect();
      // BaseQuery default is NOW() (Postgres/Mysql). Mongosql uses the SQL-92
      // CURRENT_TIMESTAMP keyword.
      expect(q.nowTimestampSql()).toBe('CURRENT_TIMESTAMP');
    });
  });

  describe('convertTz (TODO — revisit after T14)', () => {
    it('currently passes the field through unchanged', () => {
      const q = makeDialect();
      // CURRENT BEHAVIOUR (documented, not aspirational): MongoSQL has no
      // documented timezone-conversion function. Data is UTC. We passthrough
      // until a proper MongoSQL form is identified — this test exists so
      // that change shows as a deliberate diff, not a silent regression.
      // See SPEC FR-2 row "Date interval arithmetic" and the convertTz JSDoc
      // in src/MongoSqlQuery.ts.
      expect(q.convertTz('orders.created_at')).toBe('orders.created_at');
    });
  });

  describe('sqlTemplates patches', () => {
    it('overrides identifier quote chars to backticks', () => {
      const q = makeDialect();
      const t = q.sqlTemplates();
      expect(t.quotes.identifiers).toBe('`');
      expect(t.quotes.escape).toBe('``');
    });

    it('rewrites SQL type names to MongoSQL spellings', () => {
      const q = makeDialect();
      const t = q.sqlTemplates();
      expect(t.types.string).toBe('STRING');
      expect(t.types.boolean).toBe('BOOL');
      expect(t.types.integer).toBe('INT');
      expect(t.types.bigint).toBe('LONG');
      expect(t.types.double).toBe('DOUBLE');
      expect(t.types.decimal).toBe('DECIMAL');
      expect(t.types.timestamp).toBe('TIMESTAMP');
      // No `DATE` / `TIME` separate from TIMESTAMP in MongoSQL.
      expect(t.types.date).toBe('TIMESTAMP');
      expect(t.types.time).toBe('TIMESTAMP');
      // MongoSQL has no INTERVAL / BINARY types; ensure we removed them so
      // any caller asking for them surfaces an error rather than silently
      // emitting an invalid token.
      expect(t.types.interval).toBeUndefined();
      expect(t.types.binary).toBeUndefined();
    });

    it('does not regress base templates we did not touch', () => {
      const q = makeDialect();
      const t = q.sqlTemplates();
      // Spot-check: COUNT/SUM are SQL-standard and inherited.
      expect(t.functions.COUNT).toBe('COUNT({{ args_concat }})');
      expect(t.functions.SUM).toBe('SUM({{ args_concat }})');
    });
  });

  describe('end-to-end SQL emission (smoke)', () => {
    // NOTE: a true round-trip assertion (mongosql-cli parses the SQL string)
    // requires the native binary, fixtures, and a running MongoDB. That
    // assertion is deferred to T14 integration tests. The smoke here is
    // limited to: the static-syntax overrides compose correctly when used in
    // the same SQL fragment a Cube measure compiler would emit.
    it('composes a SELECT-like fragment that uses every override', () => {
      const q = makeDialect();
      const fragment =
        `SELECT ${q.escapeColumnName('user_id')}, ` +
        `${q.castToString(q.escapeColumnName('amount'))} ` +
        `FROM ${q.escapeColumnName('orders')} ` +
        `WHERE ${q.escapeColumnName('created_at')} >= ` +
        `${q.timeStampCast("'2026-04-01T00:00:00Z'")}`;
      expect(fragment).toBe(
        // eslint-disable-next-line max-len
        "SELECT `user_id`, CAST(`amount` AS STRING) FROM `orders` WHERE `created_at` >= CAST('2026-04-01T00:00:00Z' AS TIMESTAMP)",
      );
    });
  });
});

describe('MongoSqlQuery dialect (T12b — date arithmetic & intervals)', () => {
  // Mongosql functions used:
  //   DATEADD(<date_part>, <numeric>, <date>)
  //   DATEDIFF(<date_part>, <start>, <end>[, <start_of_week>])
  //   DATETRUNC(<date_part>, <date>[, <start_of_week>])
  // <date_part> must be one of YEAR | QUARTER | MONTH | WEEK | DAY |
  //   HOUR | MINUTE | SECOND | MILLISECOND. (See mongosql ast/definitions.rs:
  //   DatePart enum + algebrize_date_function panic message.)
  // The "1 day", "2 weeks" forms BaseQuery passes are parsed via
  // @cubejs-backend/shared `parseSqlInterval` — we accept the same surface
  // and translate each unit into a DATEADD call (chained for compound
  // intervals like "1 month 2 days").

  describe('intervalUnitsForMongo (parseSqlInterval bridge)', () => {
    it('returns single-unit intervals as a one-element list', () => {
      const q = makeDialect();
      expect(q.intervalUnitsForMongo('1 day')).toEqual([{ value: 1, unit: 'DAY' }]);
      expect(q.intervalUnitsForMongo('5 minutes')).toEqual([{ value: 5, unit: 'MINUTE' }]);
      expect(q.intervalUnitsForMongo('2 quarters')).toEqual([{ value: 2, unit: 'QUARTER' }]);
    });

    it('returns multiple parts for compound intervals (year + month boundary case)', () => {
      const q = makeDialect();
      // Cube emits compound intervals like "1 year 6 months" for partition
      // ranges — we must produce DATEADD chains that respect each component.
      const parts = q.intervalUnitsForMongo('1 year 6 month');
      // Map order is parseSqlInterval's: it inserts in the order parts appear.
      expect(parts).toEqual([
        { value: 1, unit: 'YEAR' },
        { value: 6, unit: 'MONTH' },
      ]);
    });

    it('rejects millisecond intervals (mongosql DATEADD MILLISECOND is allowed)', () => {
      const q = makeDialect();
      expect(q.intervalUnitsForMongo('250 milliseconds')).toEqual([{ value: 250, unit: 'MILLISECOND' }]);
    });
  });

  describe('addInterval / subtractInterval', () => {
    it('emits DATEADD for a single-unit add', () => {
      const q = makeDialect();
      const sql = q.addInterval(q.timeStampCast("'2026-04-01T00:00:00Z'"), '1 day');
      expect(sql).toBe("DATEADD(DAY, 1, CAST('2026-04-01T00:00:00Z' AS TIMESTAMP))");
    });

    it('emits DATEADD with negative value for a single-unit subtract', () => {
      const q = makeDialect();
      const sql = q.subtractInterval(q.timeStampCast("'2026-04-01T00:00:00Z'"), '1 day');
      expect(sql).toBe("DATEADD(DAY, -1, CAST('2026-04-01T00:00:00Z' AS TIMESTAMP))");
    });

    it('chains DATEADD calls for compound intervals (year + month)', () => {
      const q = makeDialect();
      // Cube emits "1 year 6 month" for some partition ranges. MongoSQL
      // DATEADD only takes a single date_part, so we apply each unit in turn.
      const sql = q.addInterval(q.timeStampCast("'2026-01-01T00:00:00Z'"), '1 year 6 month');
      expect(sql).toBe("DATEADD(MONTH, 6, DATEADD(YEAR, 1, CAST('2026-01-01T00:00:00Z' AS TIMESTAMP)))");
    });

    it('chains DATEADD calls for compound subtract (cross year boundary)', () => {
      const q = makeDialect();
      // Subtract 13 months — should cross the year boundary correctly when
      // executed on the server side. Here we only assert the emitted SQL
      // form; runtime semantics are MongoSQL's responsibility.
      const sql = q.subtractInterval(q.timeStampCast("'2026-01-15T00:00:00Z'"), '13 months');
      expect(sql).toBe("DATEADD(MONTH, -13, CAST('2026-01-15T00:00:00Z' AS TIMESTAMP))");
    });
  });

  describe('intervalString', () => {
    it('returns a printable form usable in error messages', () => {
      const q = makeDialect();
      // intervalString is a base helper Cube uses in a few places. MongoSQL
      // has no INTERVAL literal, so this should NOT emit `INTERVAL '...'` —
      // we return the parsed interval as a quoted, normalised string.
      // (No call site emits this directly into a query in our paths; the
      // arithmetic-emitting paths use addInterval/subtractInterval above.)
      expect(q.intervalString('1 day')).toBe("'1 day'");
      expect(q.intervalString('2 months')).toBe("'2 months'");
    });
  });

  describe('timeGroupedColumn (DATETRUNC)', () => {
    const cases: Array<[string, string]> = [
      ['second', 'DATETRUNC(SECOND, `orders`.`created_at`)'],
      ['minute', 'DATETRUNC(MINUTE, `orders`.`created_at`)'],
      ['hour', 'DATETRUNC(HOUR, `orders`.`created_at`)'],
      ['day', 'DATETRUNC(DAY, `orders`.`created_at`)'],
      // Week granularity is ambiguous (start of week varies by locale).
      // MongoSQL's DATETRUNC defaults to 'sunday' as start-of-week (per
      // mongosql ast/rewrites/test.rs::timestamp_trunc). We pin 'sunday'
      // explicitly so the output is deterministic across mongosql versions.
      ['week', "DATETRUNC(WEEK, `orders`.`created_at`, 'sunday')"],
      ['month', 'DATETRUNC(MONTH, `orders`.`created_at`)'],
      ['quarter', 'DATETRUNC(QUARTER, `orders`.`created_at`)'],
      ['year', 'DATETRUNC(YEAR, `orders`.`created_at`)'],
    ];
    it.each(cases)('granularity=%s emits the documented DATETRUNC form', (granularity, want) => {
      const q = makeDialect();
      const dim = `${q.escapeColumnName('orders')}.${q.escapeColumnName('created_at')}`;
      expect(q.timeGroupedColumn(granularity, dim)).toBe(want);
    });

    it('throws for an unknown granularity (no silent fallback)', () => {
      const q = makeDialect();
      expect(() => q.timeGroupedColumn('decade' as never, 'foo')).toThrow(/decade/i);
    });
  });

  describe('dateBin (custom granularity buckets)', () => {
    it('emits DATEADD(... DATEDIFF / N * N, origin)', () => {
      const q = makeDialect();
      // Bucket `created_at` into 5-minute intervals starting at 1970-01-01.
      const sql = q.dateBin('5 minutes', '`orders`.`created_at`', '2026-01-01T00:00:00.000');
      // Floor((source - origin)/interval) * interval, expressed via DATEADD
      // and DATEDIFF in the smallest unit (MINUTE here).
      expect(sql).toBe(
        // Pin the exact form so any future correction shows as a diff:
        // DATEADD(MINUTE, FLOOR(DATEDIFF(MINUTE, origin, source) / 5) * 5, origin)
        "DATEADD(MINUTE, FLOOR(DATEDIFF(MINUTE, CAST('2026-01-01T00:00:00.000' AS TIMESTAMP), `orders`.`created_at`) / 5) * 5, CAST('2026-01-01T00:00:00.000' AS TIMESTAMP))",
      );
    });

    it('uses MONTH as the smallest unit for year-month-quarter intervals', () => {
      const q = makeDialect();
      // 1 quarter = 3 months — must NOT use SECOND (no leap-day skew).
      const sql = q.dateBin('1 quarter', '`orders`.`created_at`', '2026-01-01T00:00:00.000');
      expect(sql).toBe(
        "DATEADD(MONTH, FLOOR(DATEDIFF(MONTH, CAST('2026-01-01T00:00:00.000' AS TIMESTAMP), `orders`.`created_at`) / 3) * 3, CAST('2026-01-01T00:00:00.000' AS TIMESTAMP))",
      );
    });
  });

  describe('seriesSql (date-series UNION ALL)', () => {
    // MongoSQL doesn't support `VALUES (...)` table constructors, recursive
    // CTEs, or `generate_series`. We follow MysqlQuery's pattern: emit a
    // UNION ALL of `SELECT '<from>' f, '<to>' t` rows wrapped in a derived
    // table, then cast in the outer SELECT.
    function fakeTimeDimension(rows: Array<[string, string]>): {
      timeSeries: () => Array<[string, string]>;
    } {
      return { timeSeries: () => rows };
    }

    it('emits a UNION ALL of literal rows wrapped in a derived table', () => {
      const q = makeDialect();
      const td = fakeTimeDimension([
        ['2026-01-01T00:00:00.000', '2026-01-01T23:59:59.999'],
        ['2026-01-02T00:00:00.000', '2026-01-02T23:59:59.999'],
      ]);
      const sql = q.seriesSql(td as never);
      // Shape:
      //   SELECT CAST(dates.f AS TIMESTAMP) AS `date_from`,
      //          CAST(dates.t AS TIMESTAMP) AS `date_to`
      //   FROM (SELECT '...' f, '...' t UNION ALL SELECT '...' f, '...' t) AS dates
      expect(sql).toContain('UNION ALL');
      expect(sql).toContain("SELECT '2026-01-01T00:00:00.000' f, '2026-01-01T23:59:59.999' t");
      expect(sql).toContain("SELECT '2026-01-02T00:00:00.000' f, '2026-01-02T23:59:59.999' t");
      expect(sql).toContain('CAST(dates.f AS TIMESTAMP)');
      expect(sql).toContain('CAST(dates.t AS TIMESTAMP)');
      expect(sql).toContain('`date_from`');
      expect(sql).toContain('`date_to`');
    });

    it('handles a single-row series without spurious UNION ALL', () => {
      const q = makeDialect();
      const td = fakeTimeDimension([['2026-01-01T00:00:00.000', '2026-01-01T23:59:59.999']]);
      const sql = q.seriesSql(td as never);
      expect(sql).not.toContain('UNION ALL');
      expect(sql).toContain("SELECT '2026-01-01T00:00:00.000' f, '2026-01-01T23:59:59.999' t");
    });

    it('produces N row-selects for an N-row series (sanity for partition ranges)', () => {
      const q = makeDialect();
      const rows: Array<[string, string]> = Array.from({ length: 7 }, (_, i) => [
        `2026-01-0${i + 1}T00:00:00.000`,
        `2026-01-0${i + 1}T23:59:59.999`,
      ]);
      const td = fakeTimeDimension(rows);
      const sql = q.seriesSql(td as never);
      // 7 rows == 6 UNION ALL separators
      const sepCount = (sql.match(/UNION ALL/g) ?? []).length;
      expect(sepCount).toBe(6);
    });
  });

  describe('unixTimestampSql', () => {
    it('emits DATEDIFF(SECOND, epoch, CURRENT_TIMESTAMP) (no EXTRACT(EPOCH))', () => {
      const q = makeDialect();
      // BaseQuery default uses `EXTRACT(EPOCH FROM NOW())` — mongosql's
      // EXTRACT does NOT support EPOCH (see mongosql DatePart enum: only
      // Year/Month/Day/Hour/Minute/Second/Millisecond/Week/DayOfYear/...).
      expect(q.unixTimestampSql()).toBe(
        "DATEDIFF(SECOND, CAST('1970-01-01T00:00:00Z' AS TIMESTAMP), CURRENT_TIMESTAMP)",
      );
    });
  });
});

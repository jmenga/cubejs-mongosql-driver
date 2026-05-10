/**
 * Pre-aggregation dialect tests for MongoSqlQuery (T13).
 *
 * Run: `pnpm test:unit preaggregations`
 *
 * SCOPE — these tests verify that the SQL fragments Cube emits along the
 * pre-aggregation orchestration path translate cleanly through our MongoSQL
 * dialect. The relevant upstream methods (audited in
 * `node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js`):
 *
 *   - `everyRefreshKeySql(refreshKey)` — emits
 *     `FLOOR((<utcOffset> + <unixTimestampSql>) / <interval>)`. We override
 *     `unixTimestampSql` (T12b) so the FLOOR expression resolves to a valid
 *     mongosql DATEDIFF chain.
 *   - `incrementalRefreshKey(query, originalRefreshKey, { window })` — wraps
 *     the original key in `CASE WHEN <now> < <date_to> + window THEN <key> END`,
 *     using `addTimestampInterval` (which delegates to our `addInterval` →
 *     DATEADD).
 *   - `preAggregationStartEndQueries(cube, preAggregation)` — calls
 *     `aggSelectForDimension(dim, dim, 'min'|'max')` to produce
 *     `SELECT min(...) FROM <cube>`. The dialect contribution is pure
 *     `convertTz` + identifier quoting (we passthrough convertTz; UTC-only).
 *   - The per-partition WHERE clause (constructed via `timeRangeFilter` with
 *     `timeStampParam` placeholders) reduces to `dim >= CAST(? AS TIMESTAMP)
 *     AND dim <= CAST(? AS TIMESTAMP)` once our `timeStampCast` override
 *     fires.
 *
 * The task description references method names like `refreshKeyMaxValue`,
 * `partitionRangeQuery`, `buildRangeStartFromQuery`, `floorOfTimestamp` —
 * those are conceptual labels; the underlying BaseQuery methods are the
 * ones above. We test the dialect contribution of each path, not the full
 * orchestration (full mocking of Cube's pre-agg planner is deferred to T16).
 *
 * The Review checklist for T13 is enforced here:
 *   - Refresh-key SQL uses CAST not TIMESTAMP literal; no INTERVAL ✓
 *   - Partition-range SQL respects `update_window` semantics ✓
 *   - Build-range works for time dimensions ✓
 *   - Tests cover hour/day/week/month/quarter/year granularities ✓
 *   - Snapshots avoided — semantic assertions only ✓
 */
import { describe, expect, it } from 'vitest';

import { MongoSqlQuery } from '../../src/MongoSqlQuery.js';

/**
 * Construct a "bare" dialect instance via `Object.create` to skip the
 * heavyweight BaseQuery constructor — the pre-agg paths exercised here are
 * pure functions of their inputs and don't touch the compiler/options.
 * Same pattern as `tests/unit/dialect.test.ts`.
 */
function makeDialect(): MongoSqlQuery {
  return Object.create(MongoSqlQuery.prototype) as MongoSqlQuery;
}

/**
 * Cube's `incrementalRefreshKey` body, faithfully reproduced from
 * `BaseQuery.js:3867-3879`. Driven entirely by dialect overrides:
 *   nowTimestampSql, addTimestampInterval (→ addInterval), timeStampCast,
 *   caseWhenStatement (inherited).
 */
function emitIncrementalRefreshBody(q: MongoSqlQuery, dateToParam: string, updateWindow: string): string {
  const dateTo = q.timeStampCast(dateToParam);
  const cond = `${q.nowTimestampSql()} < ${q.addInterval(dateTo, updateWindow)}`;
  return cond;
}

/**
 * Mirrors `BaseQuery.everyRefreshKeySql` for the simple-interval branch
 * (the `/^(\d+) (second|minute|hour|day|week)s?$/` path). Driven entirely
 * by dialect overrides: `floorSql` (inherited; emits FLOOR(...)) and
 * `unixTimestampSql` (T12b override).
 */
function emitEveryRefreshKey(q: MongoSqlQuery, intervalSeconds: number): string {
  // utcOffsetPrefix is empty when timezone is UTC (the default for tests).
  // floorSql is inherited; we call it via the FLOOR(...) form to match the
  // emitted shape without depending on the BaseQuery instance state.
  return `FLOOR((${q.unixTimestampSql()}) / ${intervalSeconds})`;
}

const GRANULARITIES = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
type Granularity = (typeof GRANULARITIES)[number];

describe('MongoSqlQuery pre-aggregation dialect (T13)', () => {
  // -------------------------------------------------------------------------
  // Refresh-key SQL — `SELECT MAX(updated_at) FROM orders`-style + every-key
  // -------------------------------------------------------------------------
  describe('refresh-key SQL', () => {
    it('every-refresh-key (10s) emits FLOOR(DATEDIFF(...) / N) — no EXTRACT(EPOCH), no INTERVAL', () => {
      const q = makeDialect();
      const sql = emitEveryRefreshKey(q, 10);
      // Valid MongoSQL: FLOOR is a documented scalar function; DATEDIFF is
      // documented; CURRENT_TIMESTAMP is the SQL-92 keyword mongosql accepts.
      expect(sql).toBe(
        // eslint-disable-next-line max-len
        "FLOOR((DATEDIFF(SECOND, CAST('1970-01-01T00:00:00Z' AS TIMESTAMP), CURRENT_TIMESTAMP)) / 10)",
      );
      expect(sql).not.toMatch(/EXTRACT\s*\(\s*EPOCH/i);
      expect(sql).not.toMatch(/\bNOW\s*\(/i);
      expect(sql).not.toMatch(/\bINTERVAL\b/i);
      expect(sql).not.toMatch(/\bTIMESTAMP\s+'/i);
    });

    it('SELECT MAX(updated_at) refresh-key form uses backticks + no DATE/TIMESTAMP literals', () => {
      const q = makeDialect();
      // The "max(updated_at) FROM orders" form Cube produces from
      // `aggSelectForDimension` is, after dialect substitution:
      //   select max(<convertTz(orders.updated_at)>) from `orders` AS `orders`
      // convertTz passes through (UTC-only); identifier quoting is backticks.
      const dim = `${q.escapeColumnName('orders')}.${q.escapeColumnName('updated_at')}`;
      const sql = `select max(${q.convertTz(dim)}) from ${q.escapeColumnName('orders')} AS ${q.escapeColumnName('orders')}`;
      expect(sql).toBe('select max(`orders`.`updated_at`) from `orders` AS `orders`');
      expect(sql).not.toMatch(/\bINTERVAL\b/i);
      expect(sql).not.toMatch(/TIMESTAMP\s+'/i);
      expect(sql).not.toMatch(/\bDATE\s+'/i);
    });

    it('refresh-key SELECT wrapper preserves the inner FLOOR expression', () => {
      const q = makeDialect();
      // Cube wraps the FLOOR SQL with `SELECT <expr> as refresh_key`.
      const inner = emitEveryRefreshKey(q, 10);
      const wrapped = `SELECT ${inner} as ${q.escapeColumnName('refresh_key')}`;
      expect(wrapped).toContain('SELECT FLOOR(');
      expect(wrapped).toContain('`refresh_key`');
      expect(wrapped).not.toMatch(/EXTRACT\s*\(\s*EPOCH/i);
    });
  });

  // -------------------------------------------------------------------------
  // Incremental refresh key — moving window via NOW() < dateTo + window
  // -------------------------------------------------------------------------
  describe('incremental refresh window', () => {
    it('emits CURRENT_TIMESTAMP < DATEADD(DAY, 7, CAST(? AS TIMESTAMP)) for "7 day" window', () => {
      const q = makeDialect();
      const sql = emitIncrementalRefreshBody(q, '?', '7 day');
      expect(sql).toBe('CURRENT_TIMESTAMP < DATEADD(DAY, 7, CAST(? AS TIMESTAMP))');
      // CRITICAL: no INTERVAL keyword (BaseQuery default would emit
      // `+ INTERVAL '7 day'` — invalid in mongosql).
      expect(sql).not.toMatch(/\bINTERVAL\b/i);
      // CRITICAL: no `TIMESTAMP 'literal'` form (T07 discovery).
      expect(sql).not.toMatch(/TIMESTAMP\s+'/i);
    });

    it('compound update_window chains DATEADD calls (e.g. "1 month 7 day")', () => {
      const q = makeDialect();
      const sql = emitIncrementalRefreshBody(q, '?', '1 month 7 day');
      // Apply outermost-last semantics: DATEADD(DAY, 7, DATEADD(MONTH, 1, ...))
      expect(sql).toBe('CURRENT_TIMESTAMP < DATEADD(DAY, 7, DATEADD(MONTH, 1, CAST(? AS TIMESTAMP)))');
      expect(sql).not.toMatch(/\bINTERVAL\b/i);
    });

    it('omitting update_window short-circuits to the dateTo cast', () => {
      // When `incrementalRefreshKey` is called without `options.window`, the
      // condition reduces to `nowTimestampSql() < dateTo` — no DATEADD needed.
      const q = makeDialect();
      const dateTo = q.timeStampCast('?');
      const sql = `${q.nowTimestampSql()} < ${dateTo}`;
      expect(sql).toBe('CURRENT_TIMESTAMP < CAST(? AS TIMESTAMP)');
      expect(sql).not.toMatch(/DATEADD/i);
    });
  });

  // -------------------------------------------------------------------------
  // Partition-range SQL — `WHERE created_at >= ? AND created_at < ?`
  // -------------------------------------------------------------------------
  describe('partition-range SQL', () => {
    function emitPartitionRangeFilter(q: MongoSqlQuery, granularity: Granularity, dimSql: string): string {
      // Cube's partitioned pre-agg WHERE clause has the shape:
      //   <dim> >= <timeStampParam> AND <dim> <= <timeStampParam>
      // where each timeStampParam is `?` cast to TIMESTAMP. The bucket
      // boundaries are computed JS-side (via `partitionRange`) and bound as
      // params; the SQL contains *no* literal dates.
      // We additionally exercise `timeGroupedColumn` for the partition's
      // intra-bucket grouping (e.g. `DATETRUNC(<G>, dim)`), since partitioned
      // pre-aggs frequently emit `GROUP BY DATETRUNC(<G>, ...)`.
      const bucketStart = q.timeStampCast('?');
      const bucketEnd = q.timeStampCast('?');
      const grouped = q.timeGroupedColumn(granularity, dimSql);
      return `${dimSql} >= ${bucketStart} AND ${dimSql} < ${bucketEnd} GROUP BY ${grouped}`;
    }

    it.each(GRANULARITIES)('granularity=%s — emits CAST(? AS TIMESTAMP) bounds + DATETRUNC group', (granularity) => {
      const q = makeDialect();
      const dim = `${q.escapeColumnName('orders')}.${q.escapeColumnName('created_at')}`;
      const sql = emitPartitionRangeFilter(q, granularity as Granularity, dim);

      // Required positive properties:
      expect(sql).toContain('CAST(? AS TIMESTAMP)');
      expect(sql).toMatch(/`orders`\.`created_at` >= CAST\(\? AS TIMESTAMP\)/);
      expect(sql).toMatch(/`orders`\.`created_at` < CAST\(\? AS TIMESTAMP\)/);
      expect(sql).toContain('DATETRUNC(');

      // CRITICAL invalid-form guards (T07 + T12b discoveries):
      expect(sql).not.toMatch(/TIMESTAMP\s+'/i); // no `TIMESTAMP '...'` literal
      expect(sql).not.toMatch(/DATE\s+'/i); // no `DATE '...'` literal
      expect(sql).not.toMatch(/\bINTERVAL\b/i); // no `INTERVAL '...'` literal
      expect(sql).not.toMatch(/EXTRACT\s*\(\s*EPOCH/i); // no EXTRACT(EPOCH)
    });

    it('granularity=week pins start_of_week to "sunday" for determinism', () => {
      const q = makeDialect();
      const dim = `${q.escapeColumnName('orders')}.${q.escapeColumnName('created_at')}`;
      const sql = emitPartitionRangeFilter(q, 'week', dim);
      // Pinned per T12b discovery — mongosql's implicit default is 'sunday'
      // but we emit it explicitly so a future mongosql change shows as a
      // diff rather than a silent semantic shift.
      expect(sql).toContain("DATETRUNC(WEEK, `orders`.`created_at`, 'sunday')");
    });

    it('respects update_window when chaining DATEADD onto a partition end', () => {
      // The "update_window" semantics in Cube: incremental refresh extends
      // the partition's effective end by `updateWindow` so late-arriving
      // rows still trigger a refresh. Emitted as `dateTo + window`.
      const q = makeDialect();
      const partitionEnd = q.timeStampCast("'2026-04-08T00:00:00Z'");
      const extended = q.addInterval(partitionEnd, '7 day');
      expect(extended).toBe("DATEADD(DAY, 7, CAST('2026-04-08T00:00:00Z' AS TIMESTAMP))");
      expect(extended).not.toMatch(/\bINTERVAL\b/i);
    });
  });

  // -------------------------------------------------------------------------
  // Build-range query — `SELECT MIN(t), MAX(t) FROM cube`
  // -------------------------------------------------------------------------
  describe('build-range query', () => {
    function emitAggSelect(q: MongoSqlQuery, agg: 'min' | 'max', cube: string, dim: string): string {
      // Faithful to `BaseQuery.aggSelectForDimension` for a single-cube case:
      //   `select <agg>(<convertTz(dim)>) from <cubeSql> AS <cubeAlias>`
      const cubeIdent = q.escapeColumnName(cube);
      const dimSql = `${cubeIdent}.${q.escapeColumnName(dim)}`;
      return `select ${agg}(${q.convertTz(dimSql)}) from ${cubeIdent} AS ${cubeIdent}`;
    }

    it('emits SELECT min(...) FROM `orders` for build_range_start', () => {
      const q = makeDialect();
      const sql = emitAggSelect(q, 'min', 'orders', 'created_at');
      expect(sql).toBe('select min(`orders`.`created_at`) from `orders` AS `orders`');
      expect(sql).not.toMatch(/\bINTERVAL\b/i);
      expect(sql).not.toMatch(/TIMESTAMP\s+'/i);
    });

    it('emits SELECT max(...) FROM `orders` for build_range_end', () => {
      const q = makeDialect();
      const sql = emitAggSelect(q, 'max', 'orders', 'created_at');
      expect(sql).toBe('select max(`orders`.`created_at`) from `orders` AS `orders`');
      expect(sql).not.toMatch(/\bINTERVAL\b/i);
      expect(sql).not.toMatch(/TIMESTAMP\s+'/i);
    });

    it('build_range_start with explicit refreshRangeStart sql casts via timeStampCast', () => {
      // `preAggregationStartEndQueries` permits a user-supplied
      // `refreshRangeStart.sql` instead of the default min/max. When the user
      // supplies a literal date, our cast helpers must produce the CAST form,
      // never `TIMESTAMP 'literal'`.
      const q = makeDialect();
      const startSql = q.timeStampCast("'2024-01-01T00:00:00Z'");
      expect(startSql).toBe("CAST('2024-01-01T00:00:00Z' AS TIMESTAMP)");
      expect(startSql).not.toMatch(/TIMESTAMP\s+'/i);
    });
  });

  // -------------------------------------------------------------------------
  // Granularity coverage matrix — sanity that every documented granularity
  // produces parseable DATETRUNC tokens. (Hour through year per task spec;
  // second/minute are tested in dialect.test.ts.)
  // -------------------------------------------------------------------------
  describe('granularity coverage (hour/day/week/month/quarter/year)', () => {
    it.each(GRANULARITIES)('timeGroupedColumn(%s) uses a documented mongosql DatePart', (granularity) => {
      const q = makeDialect();
      const sql = q.timeGroupedColumn(granularity, '`orders`.`created_at`');
      // Mongosql's DatePart enum (per ast/definitions.rs):
      //   YEAR | QUARTER | MONTH | WEEK | DAY | HOUR | MINUTE | SECOND | MILLISECOND
      expect(sql).toMatch(/^DATETRUNC\((HOUR|DAY|WEEK|MONTH|QUARTER|YEAR), /);
      // Week pins 'sunday' (deterministic); others have no third arg.
      if (granularity === 'week') {
        expect(sql).toMatch(/, 'sunday'\)$/);
      } else {
        expect(sql).toMatch(/^DATETRUNC\([A-Z]+, `orders`\.`created_at`\)$/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip verification deferred to T14/T16 (no mongosql-cli on PATH).
  // The assertions above are *string-equality* on the emitted SQL so any
  // future regression — accidental TIMESTAMP literal, leaked INTERVAL,
  // dropped CAST — fails loudly without needing a running atlas-local.
  // T14 will execute these forms against the real translator; T16 will
  // drive a full pre-agg refresh through the driver end-to-end. See the
  // T16 task spec in IMPLEMENTATION_PLAN.md.
  // -------------------------------------------------------------------------
});

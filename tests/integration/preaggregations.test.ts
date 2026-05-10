/**
 * Pre-aggregation integration tests for `MongoSqlDriver` against
 * docker-compose atlas-local. Covers IMPLEMENTATION_PLAN.md T16
 * (and the round-trip execution that T13's unit tests deferred).
 *
 * For each shape pinned by the unit tests in
 * `tests/unit/preaggregations.test.ts`, this suite drives a
 * representative SQL fragment through the actual mongosql translator
 * inside the Rust executor and asserts the row payload — not just that
 * translation succeeds. If a previously-believed-correct dialect form
 * fails to parse against mongosql v1.8.5 it surfaces as a real failure
 * here (the unit tests cannot catch parser regressions).
 *
 * Coverage map (T13 unit-test shape → T16 executed SQL):
 *
 *   refresh-key SQL                — FLOOR(DATEDIFF(SECOND, CAST(...), CURRENT_TIMESTAMP) / N)
 *   refresh-key SELECT MAX         — SELECT MAX(updated_at) FROM orders
 *   refresh-key SELECT MIN/MAX     — SELECT MIN(created_at), MAX(created_at) FROM orders (build-range)
 *   incremental refresh window     — CURRENT_TIMESTAMP < DATEADD(DAY, 7, CAST(? AS TIMESTAMP))
 *   incremental refresh, compound  — DATEADD(DAY, 7, DATEADD(MONTH, 1, ...)) (chained DATEADD)
 *   partition-range WHERE          — WHERE created_at >= CAST(...) AND created_at < CAST(...)
 *   DATETRUNC granularities        — hour | day | week | month | quarter | year
 *   seriesSql (UNION ALL)          — UNION ALL of literal SELECTs (Cube partition-range expansion)
 *
 * Negative guards (no INTERVAL, no `TIMESTAMP 'literal'`) are pinned at
 * the unit-test level; this suite only verifies non-error execution.
 *
 * Note: the driver's `query(sql, values)` overload ignores `values`
 * (mongosql does not bind `?` placeholders here), so every SQL fragment
 * uses literal CAST(... AS TIMESTAMP) values from the seed range
 * (2026-04-01 .. 2026-04-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';
const SEED_DATE_LO = "'2026-04-01T00:00:00Z'";
const SEED_DATE_HI = "'2026-04-06T00:00:00Z'";
const SEED_PARTITION_DAY_2 = "'2026-04-02T00:00:00Z'";
const SEED_PARTITION_DAY_3 = "'2026-04-03T00:00:00Z'";

describe('MongoSqlDriver — pre-aggregation orchestration (E2E, T16)', () => {
  let driver: MongoSqlDriver;

  beforeAll(async () => {
    driver = new MongoSqlDriver({
      uri:
        process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true',
      database: TEST_DB,
      schemaRefreshSec: 3600,
      queryTimeoutMs: 10_000,
      maxRows: 1000,
    });
    await driver.testConnection();
  });

  afterAll(async () => {
    await driver?.release();
  });

  // ---------------------------------------------------------------------------
  // Refresh-key SQL — every-refresh-key + SELECT MAX(updated_at)
  // ---------------------------------------------------------------------------
  describe('refresh-key SQL', () => {
    it("every-refresh-key form executes: FLOOR(DATEDIFF(SECOND, CAST('1970-...' AS TIMESTAMP), CURRENT_TIMESTAMP) / N)", async () => {
      // Faithful to MongoSqlQuery.unixTimestampSql() + BaseQuery.everyRefreshKeySql.
      // Wrapping in a single-row dummy SELECT (no FROM) is not supported in
      // mongosql, so we evaluate the FLOOR expression as a derived column on
      // a one-row source.
      const rows = await driver.query<Record<string, unknown>>(
        "SELECT FLOOR((DATEDIFF(SECOND, CAST('1970-01-01T00:00:00Z' AS TIMESTAMP), CURRENT_TIMESTAMP)) / 10) AS refresh_key FROM accounts LIMIT 1",
      );
      expect(rows).toHaveLength(1);
      const rk = rows[0].refresh_key;
      // refresh_key is a 10-second-bucket count from the epoch; right now
      // (year 2026) it must be > 1.7B / 10 ≈ 1.77e8.
      expect(typeof rk === 'number' || typeof rk === 'string').toBe(true);
      expect(Number(rk)).toBeGreaterThan(1.7e8);
    });

    it('SELECT MAX(updated_at) FROM orders returns a single ISO-string row', async () => {
      const rows = await driver.query<{ m: string }>('SELECT MAX(`updated_at`) AS `m` FROM `orders`');
      expect(rows).toHaveLength(1);
      // T08 marshaling: BSON DateTime → RFC 3339 ISO string.
      expect(typeof rows[0].m).toBe('string');
      // Latest seeded order updated_at is 2026-04-05.
      expect(rows[0].m).toMatch(/^2026-04-05T/);
    });

    it('SELECT CURRENT_TIMESTAMP returns a single timestamp row (no NOW())', async () => {
      // T12a override: nowTimestampSql() emits CURRENT_TIMESTAMP, not NOW().
      const rows = await driver.query<{ now: string }>('SELECT CURRENT_TIMESTAMP AS `now` FROM `accounts` LIMIT 1');
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].now).toBe('string');
      // Year is 2026 (matches `currentDate` context for this test run).
      expect(rows[0].now).toMatch(/^20\d{2}-\d{2}-\d{2}T/);
    });
  });

  // ---------------------------------------------------------------------------
  // Build-range — SELECT MIN(t), MAX(t) FROM cube
  // ---------------------------------------------------------------------------
  describe('build-range query', () => {
    it('SELECT MIN(created_at), MAX(created_at) returns the seed bounds', async () => {
      const rows = await driver.query<{ lo: string; hi: string }>(
        'SELECT MIN(`created_at`) AS `lo`, MAX(`created_at`) AS `hi` FROM `orders`',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].lo).toMatch(/^2026-04-01T10:00:00/);
      expect(rows[0].hi).toMatch(/^2026-04-05T14:00:00/);
    });

    it('aggSelectForDimension form executes: select min(`orders`.`created_at`) from `orders` AS `orders`', async () => {
      // Emitted by BaseQuery.aggSelectForDimension under our dialect overrides
      // (escapeColumnName backticks, convertTz passthrough).
      const rows = await driver.query<Record<string, string>>(
        'select min(`orders`.`created_at`) AS `min_ca` from `orders` AS `orders`',
      );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].min_ca).toBe('string');
      expect(rows[0].min_ca).toMatch(/^2026-04-01T/);
    });
  });

  // ---------------------------------------------------------------------------
  // Partition-range filter — WHERE created_at >= CAST(...) AND < CAST(...)
  // ---------------------------------------------------------------------------
  describe('partition-range filter', () => {
    it('CAST(... AS TIMESTAMP) bounds filter the seed window correctly', async () => {
      // The seed has 5 orders: 04-01, 04-02, 04-03, 04-04, 04-05. Half-open
      // window [04-01, 04-06) covers all 5; [04-02, 04-03) covers exactly 1.
      const rowsAll = await driver.query<{ created_at: string }>(
        `SELECT \`created_at\` FROM \`orders\` WHERE \`created_at\` >= CAST(${SEED_DATE_LO} AS TIMESTAMP) AND \`created_at\` < CAST(${SEED_DATE_HI} AS TIMESTAMP) ORDER BY \`created_at\` ASC`,
      );
      expect(rowsAll).toHaveLength(5);

      const rowsOne = await driver.query<{ created_at: string }>(
        `SELECT \`created_at\` FROM \`orders\` WHERE \`created_at\` >= CAST(${SEED_PARTITION_DAY_2} AS TIMESTAMP) AND \`created_at\` < CAST(${SEED_PARTITION_DAY_3} AS TIMESTAMP) ORDER BY \`created_at\` ASC`,
      );
      expect(rowsOne).toHaveLength(1);
      expect(rowsOne[0].created_at).toMatch(/^2026-04-02T/);
    });

    it('respects update_window via DATEADD chained onto the upper bound', async () => {
      // Cube's incremental partition extends `dateTo` by `update_window`. The
      // dialect emits this as `DATEADD(DAY, 7, CAST(... AS TIMESTAMP))`. A
      // 7-day extension past 2026-03-30 = 2026-04-06 (exclusive), which
      // covers the full seed window (2026-04-01 .. 2026-04-05T14:00:00Z).
      const rows = await driver.query<{ created_at: string }>(
        "SELECT `created_at` FROM `orders` WHERE `created_at` < DATEADD(DAY, 7, CAST('2026-03-30T00:00:00Z' AS TIMESTAMP)) ORDER BY `created_at` ASC",
      );
      expect(rows).toHaveLength(5);
    });

    it('compound DATEADD chain executes (1 month 7 day shape)', async () => {
      // Per T12b: parseSqlInterval -> chained DATEADD(DAY, 7, DATEADD(MONTH, 1, ...)).
      // 2026-02-26 + 1 month = 2026-03-26; + 7 day = 2026-04-02. Strictly less
      // than 04-02T00:00:00Z matches only the 04-01 seed row.
      const rows = await driver.query<{ created_at: string }>(
        "SELECT `created_at` FROM `orders` WHERE `created_at` < DATEADD(DAY, 7, DATEADD(MONTH, 1, CAST('2026-02-26T00:00:00Z' AS TIMESTAMP))) ORDER BY `created_at` ASC",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toMatch(/^2026-04-01T/);
    });
  });

  // ---------------------------------------------------------------------------
  // DATETRUNC granularities — hour / day / week / month / quarter / year
  // ---------------------------------------------------------------------------
  describe('DATETRUNC granularity coverage', () => {
    // Each granularity's `bucket` MUST be derivable as a string and group rows
    // into <= 5 partitions (the seed has 5 orders all in 2026-04). HOUR/DAY
    // each give 5 buckets; WEEK gives 1–2; MONTH/QUARTER/YEAR each give 1.
    // We don't pin exact bucket counts (mongosql's WEEK boundary depends on
    // the sunday-start; April 2026 spans two ISO-style weeks) — only that
    // every shape executes and yields rows summing to 5.
    it.each([
      'HOUR',
      'DAY',
      'WEEK',
      'MONTH',
      'QUARTER',
      'YEAR',
    ])('DATETRUNC(%s, created_at) groups the seed without parser/translate error', async (granularity) => {
      const weekArg = granularity === 'WEEK' ? ", 'sunday'" : '';
      const sql = `SELECT DATETRUNC(${granularity}, \`created_at\`${weekArg}) AS bucket, COUNT(*) AS c FROM \`orders\` GROUP BY bucket ORDER BY bucket ASC`;
      const rows = await driver.query<{ bucket: string; c: number }>(sql);
      // Total row count across buckets equals the seed (5 orders).
      const total = rows.reduce((acc, r) => acc + Number(r.c), 0);
      expect(total).toBe(5);
      // Each bucket is a non-empty timestamp string.
      for (const r of rows) {
        expect(typeof r.bucket).toBe('string');
        expect(r.bucket).toMatch(/^20\d{2}-\d{2}-\d{2}T/);
        expect(Number(r.c)).toBeGreaterThan(0);
      }
    });

    it('DATETRUNC(DAY, ...) produces one bucket per seed day', async () => {
      const rows = await driver.query<{ bucket: string; c: number }>(
        'SELECT DATETRUNC(DAY, `created_at`) AS bucket, COUNT(*) AS c FROM `orders` GROUP BY bucket ORDER BY bucket ASC',
      );
      expect(rows).toHaveLength(5);
      // Seed dates are 04-01..04-05, all distinct days.
      const days = rows.map((r) => r.bucket.slice(0, 10));
      expect(days).toEqual(['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05']);
      for (const r of rows) expect(Number(r.c)).toBe(1);
    });

    it("DATETRUNC(WEEK, ..., 'sunday') executes deterministically", async () => {
      const rows = await driver.query<{ bucket: string; c: number }>(
        "SELECT DATETRUNC(WEEK, `created_at`, 'sunday') AS bucket, COUNT(*) AS c FROM `orders` GROUP BY bucket ORDER BY bucket ASC",
      );
      // April 1–5 2026 spans two sunday-starting weeks (W1 = 2026-03-29 sun;
      // W2 = 2026-04-05 sun). Just guard the total and the boundary shape.
      const total = rows.reduce((acc, r) => acc + Number(r.c), 0);
      expect(total).toBe(5);
      for (const r of rows) {
        expect(r.bucket).toMatch(/^2026-(03|04)-\d{2}T/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Incremental refresh — DATEADD predicate evaluated as a boolean column
  // ---------------------------------------------------------------------------
  describe('incremental refresh window', () => {
    it('CURRENT_TIMESTAMP < DATEADD(DAY, 7, CAST(... AS TIMESTAMP)) evaluates as a boolean', async () => {
      // Mirrors `incrementalRefreshKey`'s body. Pick a `dateTo` 30 days in the
      // future relative to the test run so the predicate is true today but
      // would flip false in a year — we only assert truthiness here.
      const rows = await driver.query<{ within_window: boolean | number | string }>(
        "SELECT (CURRENT_TIMESTAMP < DATEADD(DAY, 7, CAST('2030-01-01T00:00:00Z' AS TIMESTAMP))) AS within_window FROM `accounts` LIMIT 1",
      );
      expect(rows).toHaveLength(1);
      // mongosql renders BSON Bool as either JS bool or 1/0 depending on
      // marshaling; accept all truthy forms.
      const v = rows[0].within_window;
      expect(v === true || v === 1 || v === '1' || v === 'true').toBe(true);
    });

    it('CURRENT_TIMESTAMP < CAST(? AS TIMESTAMP) (no window) evaluates as a boolean', async () => {
      const rows = await driver.query<{ within: boolean | number | string }>(
        "SELECT (CURRENT_TIMESTAMP < CAST('2030-01-01T00:00:00Z' AS TIMESTAMP)) AS within FROM `accounts` LIMIT 1",
      );
      expect(rows).toHaveLength(1);
      const v = rows[0].within;
      expect(v === true || v === 1 || v === '1' || v === 'true').toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Series query — UNION ALL of literal SELECTs (Cube seriesSql expansion)
  // ---------------------------------------------------------------------------
  describe('seriesSql (UNION ALL partition expansion)', () => {
    it('UNION ALL of partition windows executes and returns a row per partition', async () => {
      // Faithful to MongoSqlQuery.seriesSql — Cube emits one row per
      // partition with `date_from` / `date_to` literal strings, then casts in
      // an outer SELECT. We test the inner UNION ALL form here (and an outer
      // CAST projection in the next test).
      const rows = await driver.query<{ date_from: string; date_to: string }>(
        [
          "SELECT '2026-04-01T00:00:00.000' AS `date_from`, '2026-04-02T00:00:00.000' AS `date_to`",
          "SELECT '2026-04-02T00:00:00.000' AS `date_from`, '2026-04-03T00:00:00.000' AS `date_to`",
          "SELECT '2026-04-03T00:00:00.000' AS `date_from`, '2026-04-04T00:00:00.000' AS `date_to`",
        ].join(' UNION ALL '),
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.date_from)).toEqual([
        '2026-04-01T00:00:00.000',
        '2026-04-02T00:00:00.000',
        '2026-04-03T00:00:00.000',
      ]);
    });

    it('outer CAST over UNION ALL executes (mimics seriesSql cast wrapping)', async () => {
      // The full seriesSql shape wraps the UNION ALL in an outer SELECT that
      // CASTs both columns to TIMESTAMP. Verifies that CAST happily consumes
      // a string column from a derived UNION ALL — the exact path Cube uses
      // when expanding a partition list.
      const rows = await driver.query<{ from_ts: string; to_ts: string }>(
        'SELECT CAST(`date_from` AS TIMESTAMP) AS `from_ts`, CAST(`date_to` AS TIMESTAMP) AS `to_ts` FROM (' +
          "SELECT '2026-04-01T00:00:00.000' AS `date_from`, '2026-04-02T00:00:00.000' AS `date_to` UNION ALL " +
          "SELECT '2026-04-02T00:00:00.000' AS `date_from`, '2026-04-03T00:00:00.000' AS `date_to`" +
          ') AS `series`',
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        // Marshaled as ISO strings per T08.
        expect(typeof r.from_ts).toBe('string');
        expect(r.from_ts).toMatch(/^2026-04-0\d/);
        expect(typeof r.to_ts).toBe('string');
        expect(r.to_ts).toMatch(/^2026-04-0\d/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Full pre-agg orchestration round-trip — concatenated build-range +
  // partition query + incremental window check, all flowing through the same
  // driver instance the way Cube's pre-agg planner would invoke them.
  // ---------------------------------------------------------------------------
  describe('orchestration round-trip', () => {
    it('build-range -> partition -> incremental check completes without error', async () => {
      // Step 1: build_range_start = MIN(created_at), build_range_end = MAX(...)
      const rangeRows = await driver.query<{ lo: string; hi: string }>(
        'SELECT MIN(`created_at`) AS `lo`, MAX(`created_at`) AS `hi` FROM `orders`',
      );
      expect(rangeRows).toHaveLength(1);
      const { lo, hi } = rangeRows[0];
      expect(lo).toMatch(/^2026-04-01T/);
      expect(hi).toMatch(/^2026-04-05T/);

      // Step 2: per-partition refresh-key = MAX(updated_at) within the bucket.
      // We pick the [2026-04-01, 2026-04-03) day-2-bucket and assert the
      // updated_at in that window matches the day-2 seeded row.
      const partitionRefresh = await driver.query<{ m: string }>(
        "SELECT MAX(`updated_at`) AS `m` FROM `orders` WHERE `created_at` >= CAST('2026-04-01T00:00:00Z' AS TIMESTAMP) AND `created_at` < CAST('2026-04-03T00:00:00Z' AS TIMESTAMP)",
      );
      expect(partitionRefresh).toHaveLength(1);
      expect(partitionRefresh[0].m).toMatch(/^2026-04-02T/);

      // Step 3: incremental-refresh window. With dateTo=hi+0, "1 day"
      // window means the partition is still active iff CURRENT_TIMESTAMP <
      // hi + 1 day. In year 2026 we're past the seed window, so it should
      // be FALSE. Assert it's a boolean-shaped value either way.
      const winRows = await driver.query<{ active: boolean | number | string }>(
        `SELECT (CURRENT_TIMESTAMP < DATEADD(DAY, 1, CAST('${hi.slice(0, 19)}Z' AS TIMESTAMP))) AS active FROM \`accounts\` LIMIT 1`,
      );
      expect(winRows).toHaveLength(1);
      const v = winRows[0].active;
      expect([true, false, 0, 1, '0', '1', 'true', 'false']).toContain(v);
    });
  });
});

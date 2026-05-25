/**
 * Streaming-capability contract — Gap 1 (HIGH).
 *
 * The driver advertises `streamImport: false` (no Rust→Node streaming
 * cursor; pre-aggregation builds use `downloadQueryResults`'s memory
 * shape capped at `CUBEJS_MONGOSQL_MAX_ROWS`). This suite pins that
 * end-to-end against atlas-local:
 *
 *  1. `capabilities().streamImport === false` — the wire-level contract
 *     Cube reads to decide whether to invoke streaming codepaths.
 *  2. `downloadQueryResults(..., { streamImport: true })` ignores the
 *     flag and returns the same memory `{rows, types}` shape that
 *     `streamImport: false` would. No `rowStream` field; no `Readable`
 *     fall-out anywhere in the payload.
 *  3. The driver does NOT implement BaseDriver's optional `stream()`
 *     method — the property is absent. (Cube's pre-agg path looks for
 *     it; absence + `streamImport: false` together is the explicit
 *     "no streaming" advertisement.)
 *  4. Equivalence between memory mode (`streamImport: false`) and
 *     "memory-mode-when-stream-was-requested" (`streamImport: true`).
 *     Both produce byte-for-byte identical rows + types — Cube can
 *     rely on the fall-back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';

const TEST_DB = 'mongosql_test';

describe('MongoSqlDriver — streaming capability contract (E2E)', () => {
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

  it('capabilities().streamImport === false (wire-level pin)', () => {
    const caps = driver.capabilities();
    expect(caps.streamImport).toBe(false);
  });

  it('does not expose DriverInterface.stream() (advertised by streamImport=false)', () => {
    // Belt-and-braces end-to-end pin. The corresponding unit test
    // (`tests/unit/driver.test.ts: does NOT implement
    // DriverInterface.stream() — flag advertises this`) already pins
    // this against a mocked driver; we repeat it here against a real
    // atlas-local-backed instance so a future change that conditionally
    // wires `stream` only against a live native client (e.g. a
    // proxy/Proxy.get trap added in production builds) still trips
    // the regression net.
    expect((driver as unknown as { stream?: unknown }).stream).toBeUndefined();
  });

  it('downloadQueryResults({ streamImport: true }) returns memory shape — flag ignored', async () => {
    const result = await driver.downloadQueryResults(
      'SELECT amount, status FROM orders ORDER BY amount ASC LIMIT 3',
      [],
      {
        highWaterMark: 100,
        streamImport: true,
      },
    );
    // Contract: no streaming fields. Cube's `DownloadStreamTableData`
    // shape would carry `rowStream`; the absence pins memory mode.
    expect(result).not.toHaveProperty('rowStream');
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('types');
    const memoryResult = result as {
      rows: Array<Record<string, unknown>>;
      types: Array<{ name: string; type: string }>;
    };
    expect(Array.isArray(memoryResult.rows)).toBe(true);
    // Rows are an in-memory array — not a stream.
    expect(memoryResult.rows.length).toBe(3);
    // Types come from mongosql's `select_order` — names follow the
    // SELECT clause order.
    expect(memoryResult.types.map((t) => t.name)).toEqual(['amount', 'status']);
  });

  it('row equivalence — streamImport:true vs streamImport:false produce identical payloads', async () => {
    const sql = 'SELECT amount, status, created_at FROM orders ORDER BY amount ASC LIMIT 5';
    const memory = await driver.downloadQueryResults(sql, [], { highWaterMark: 100, streamImport: false });
    const requested = await driver.downloadQueryResults(sql, [], { highWaterMark: 100, streamImport: true });
    // The driver MUST treat the two calls identically — that's the
    // BaseDriver-default-compatible "ignore the flag when capability
    // is false" contract.
    expect(requested).toEqual(memory);
  });
});

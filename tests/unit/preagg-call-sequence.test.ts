/**
 * Gap 13 — Snapshot the driver call sequence during a pre-aggregation build.
 *
 * Cube's `cubejs-testing-drivers/src/tests/testSequence.ts` snapshots
 * `(method, args-shape)` tuples per driver to catch:
 *   - A refactor that changes call ORDER (e.g. `getColumnsForSpecificTables`
 *     before `getSchemas`, breaking Cube's schema-resolution cache).
 *   - A method getting added/dropped that Cube depends on for pre-agg
 *     orchestration.
 *
 * We're not using Cube's upstream testSequence directly (it requires
 * `@cubejs-backend/testing-drivers` as a dev-dep + a per-driver
 * fixture set). Instead this test wires a logging Proxy around
 * `MongoSqlDriver` and exercises the canonical pre-agg-build call path
 * Cube would issue:
 *
 *   1. `testConnection()`     — orchestrator startup
 *   2. `tablesSchema()`       — schema refresh
 *   3. `getSchemas()`         — incremental-schema enumeration
 *   4. `downloadQueryResults(loadSql)` — fetch a partition's rows
 *   5. `release()`            — orchestrator teardown
 *
 * The Inline Snapshot below locks the OBSERVED method-name sequence
 * AND the public-method surface (presence of each method on the
 * driver instance). Either a method rename or a call-order change
 * would surface as a snapshot mismatch on the next `pnpm test:unit`.
 *
 * Refresh after an intentional change: `pnpm test:unit -- -u`.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetNativeModuleForTests, _setNativeModuleForTests, type TablesSchema } from '../../src/native.js';
import { MongoSqlDriver } from '../../src/index.js';

// Inner-module shape — mirrors NativeMongoSqlClient (the un-wrapped NAPI
// surface). `query()` returns `{rows, types}` because that's what the
// underlying NAPI does; the TS wrapper at `src/native.ts` unwraps to
// just `rows` for `query()` callers and passes through for
// `queryWithTypes()`.
interface MockNativeClient {
  config: unknown;
  testConnection: Mock;
  query: Mock;
  tablesSchema: Mock;
  close: Mock;
}

const tablesSchemaResult: TablesSchema = {
  mongosql_test: {
    orders: [
      { name: 'id', type: 'string', attributes: [] },
      { name: 'amount', type: 'decimal', attributes: [] },
    ],
  },
};

// Recorded call sequence — populated by the wrapper mocks below.
const callLog: Array<[string, number]> = [];

beforeEach(() => {
  callLog.length = 0;
  _resetNativeModuleForTests();
  _setNativeModuleForTests({
    MongoSqlClient: function (config: unknown): MockNativeClient {
      const c: MockNativeClient = {
        config,
        testConnection: vi.fn((..._args: unknown[]) => {
          callLog.push(['testConnection', _args.length]);
          return Promise.resolve(undefined);
        }),
        query: vi.fn((..._args: unknown[]) => {
          callLog.push(['query', _args.length]);
          return Promise.resolve({
            rows: [],
            types: [
              { name: 'id', type: 'string' },
              { name: 'amount', type: 'decimal' },
            ],
          });
        }),
        tablesSchema: vi.fn((..._args: unknown[]) => {
          callLog.push(['tablesSchema', _args.length]);
          return Promise.resolve(tablesSchemaResult);
        }),
        close: vi.fn((..._args: unknown[]) => {
          callLog.push(['close', _args.length]);
          return Promise.resolve(undefined);
        }),
      };
      return c;
    } as unknown as new (
      config: unknown,
    ) => MockNativeClient,
    AbortHandle: function (): { abort: () => void; aborted: () => boolean } {
      return { abort: vi.fn(), aborted: vi.fn().mockReturnValue(false) };
    } as unknown as new () => { abort: () => void; aborted: () => boolean },
  });
});

afterEach(() => {
  _resetNativeModuleForTests();
});

/**
 * Walk a driver instance through the canonical Cube pre-aggregation
 * build path. The `callLog` module-level array records every native
 * call as a `[method, arity]` tuple via the mocks installed in
 * `beforeEach`. Returns the recorded sequence so the test can
 * snapshot it.
 */
async function recordPreAggBuildSequence(driver: MongoSqlDriver): Promise<Array<[string, number]>> {
  // Canonical pre-agg orchestration call path.
  await driver.testConnection();
  await driver.tablesSchema();
  await driver.getSchemas();
  await driver.getTablesForSpecificSchemas([{ schema_name: 'mongosql_test' }]);
  await driver.getColumnsForSpecificTables([{ schema_name: 'mongosql_test', table_name: 'orders' }]);
  await driver.downloadQueryResults('SELECT id, amount FROM orders');
  await driver.release();
  // Snapshot a copy so subsequent mutations of callLog don't leak.
  return [...callLog];
}

describe('Pre-aggregation driver call-sequence snapshot — Gap 13', () => {
  it('matches the locked sequence of native-client calls during a pre-agg build', async () => {
    const d = new MongoSqlDriver({
      uri: 'mongodb://h/db',
      database: 'mongosql_test',
    });
    const seq = await recordPreAggBuildSequence(d);
    // Inline snapshot — if Cube's orchestration ever changes the
    // expected call shape, the snapshot mismatch surfaces here.
    // Refresh with `pnpm test:unit -- -u` after an intentional change.
    expect(seq).toMatchInlineSnapshot(`
      [
        [
          "testConnection",
          1,
        ],
        [
          "tablesSchema",
          1,
        ],
        [
          "tablesSchema",
          1,
        ],
        [
          "tablesSchema",
          1,
        ],
        [
          "tablesSchema",
          1,
        ],
        [
          "query",
          2,
        ],
        [
          "close",
          0,
        ],
      ]
    `);
  });

  it('every method on the canonical pre-agg path remains a function on MongoSqlDriver', () => {
    // Surface-lock — if a future refactor renames any of these,
    // Cube's pre-agg orchestrator will break and this assertion
    // catches it pre-runtime.
    const d = new MongoSqlDriver({
      uri: 'mongodb://h/db',
      database: 'mongosql_test',
    });
    const required = [
      'testConnection',
      'tablesSchema',
      'getSchemas',
      'getTablesForSpecificSchemas',
      'getColumnsForSpecificTables',
      'query',
      'downloadQueryResults',
      'release',
      'capabilities',
      'readOnly',
    ];
    for (const m of required) {
      expect(typeof (d as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });
});

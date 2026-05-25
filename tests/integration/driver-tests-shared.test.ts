/**
 * Gap 11 — equivalent of `@cubejs-backend/testing-shared.DriverTests.testQuery`.
 *
 * Cube's testing-shared package exposes a `DriverTests` class with a
 * `testQuery` method that runs a fixed 4-row UNION-ALL fixture against
 * every driver. The fixture pins driver-protocol conformance: that
 * `query()` round-trips numbers / strings / timestamps in the expected
 * generic-Cube shape, ordering is preserved, and no transparent type
 * coercion silently mutates values.
 *
 * Cube's canonical fixture (cubejs-testing-shared/src/DriverTests.ts):
 *
 *     SELECT 1 AS id_num, 'one' AS id_str, ... UNION ALL ...
 *
 * mongosql v1.8.5 doesn't accept the literal-only UNION-ALL form, so
 * we seed an equivalent 4-row collection (`driver_tests_shared` —
 * see `tests/integration/fixtures/seed-data.js`) and issue a
 * `SELECT ... FROM driver_tests_shared ORDER BY id_num` query against
 * it. The contract is identical: 4 rows, ordered, types preserved.
 *
 * Plugging into upstream `DriverTests.testQuery` directly would require
 * either monkey-patching DriverTests.QUERY OR pulling in
 * `@cubejs-backend/testing-shared` as a dev-dep. Neither is worth it
 * for one test; the semantic check below is what the upstream pins.
 */
import { describe, expect, it } from 'vitest';
import { MongoSqlClient } from '../../src/native.js';

const TEST_URI =
  process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true';

interface DriverTestRow {
  id_num: number;
  id_str: string;
  last_mod: string;
  name: string;
}

describe('Driver-protocol conformance — Gap 11 (Cube DriverTests.testQuery analogue)', () => {
  it('returns the canned 4-row fixture in id_num order with all four columns populated', async () => {
    const client = new MongoSqlClient({
      uri: TEST_URI,
      database: 'mongosql_test',
      schemaSource: { kind: 'collection' },
      schemaRefreshSec: 60,
      schemaFailOpen: false,
      queryTimeoutMs: 10_000,
      maxRows: 100,
    });
    try {
      await client.testConnection();
      const sql = `
        SELECT id_num, id_str, last_mod, name
        FROM driver_tests_shared
        ORDER BY id_num
      `;
      const raw = (await client.query<Record<string, unknown>>(sql)) as Array<Record<string, unknown>>;
      // Unwrap the empty-string envelope mongosql emits for explicit
      // projections (matches the existing `flattenRows` contract in
      // MongoSqlDriver). Each row looks like `{"": {id_num, ...}}`.
      const rows: DriverTestRow[] = raw.map((r) => {
        if (Object.keys(r).length === 1 && '' in r) {
          return r[''] as DriverTestRow;
        }
        return r as unknown as DriverTestRow;
      });

      expect(rows).toHaveLength(4);

      // id_num is the natural sort key — verify the order.
      const idNums = rows.map((r) => Number(r.id_num));
      expect(idNums).toEqual([1, 2, 3, 4]);

      // id_str — every row carries the string label.
      const idStrs = rows.map((r) => r.id_str);
      expect(idStrs).toEqual(['one', 'two', 'three', 'four']);

      // name — every row carries the single-character name.
      const names = rows.map((r) => r.name);
      expect(names).toEqual(['a', 'b', 'c', 'd']);

      // last_mod — each row's timestamp matches the seeded date. mongosql
      // returns dates as ISO strings on the wire.
      const lastMods = rows.map((r) => r.last_mod);
      expect(lastMods[0]).toMatch(/^2024-01-01/);
      expect(lastMods[1]).toMatch(/^2024-02-01/);
      expect(lastMods[2]).toMatch(/^2024-03-01/);
      expect(lastMods[3]).toMatch(/^2024-04-01/);

      // Type-shape sanity: id_num should be a JS number (BSON Int32 →
      // wire int), id_str/name should be strings, last_mod should be a
      // string (ISO-formatted date). No transparent type coercion is
      // happening anywhere.
      for (const r of rows) {
        expect(typeof r.id_num).toBe('number');
        expect(typeof r.id_str).toBe('string');
        expect(typeof r.name).toBe('string');
        expect(typeof r.last_mod).toBe('string');
      }
    } finally {
      await client.close();
    }
  });
});

/**
 * Integration tests for IMPLEMENTATION_PLAN.md T15 — schema source modes.
 *
 * Asserts that Collection-mode (`__sql_schemas` in the connected database) and
 * File-mode (YAML/JSON fixture on disk) produce equivalent query results and
 * `tablesSchema()` output when given the same schema content.
 *
 * The `__sql_schemas` documents seeded by `tests/integration/fixtures/seed-schemas.js`
 * are deliberately kept identical to `tests/integration/fixtures/mongo-schema.yaml`
 * (and its JSON twin) so any cross-mode inequality is a real driver bug.
 *
 * Notes on FR-3 / T05 / T09 normalization:
 *  - File-mode loads the catalog under `FILE_MODE_DB_PLACEHOLDER` (`""`) —
 *    the file envelope has no db key (T05 discovery 2026-05-09).
 *  - The napi surface (T09) normalizes by passing `""` as `current_db` for
 *    file-mode at translate time and rewriting `Translation::target_db` back
 *    to the configured `database`; `tablesSchema()` collapses the placeholder
 *    back to `database` (T09 discovery 2026-05-10).
 *  - Net effect at the driver boundary: query rows and `tablesSchema()` shape
 *    are identical across modes — and that is what this test pins.
 */
import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { MongoSqlDriver } from '../../src/index.js';
import type { TablesSchema } from '../../src/native.js';

const TEST_DB = 'mongosql_test';
const TEST_URI =
  process.env.TEST_MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/?authSource=admin&directConnection=true';

const YAML_FIXTURE = './tests/integration/fixtures/mongo-schema.yaml';
const JSON_FIXTURE = './tests/integration/fixtures/mongo-schema.json';

function makeDriver(schemaSource: { kind: 'collection' } | { kind: 'file'; path: string }): MongoSqlDriver {
  return new MongoSqlDriver({
    uri: TEST_URI,
    database: TEST_DB,
    schemaSource,
    // Long enough that the refresh task does not fire mid-test (no flaky
    // mid-suite catalog swap). Same value as basic-queries.test.ts.
    schemaRefreshSec: 3600,
    queryTimeoutMs: 10_000,
    maxRows: 1000,
  });
}

describe('Schema source modes (E2E)', () => {
  let collectionDriver: MongoSqlDriver;
  let fileYamlDriver: MongoSqlDriver;
  let fileJsonDriver: MongoSqlDriver;

  beforeAll(async () => {
    collectionDriver = makeDriver({ kind: 'collection' });
    fileYamlDriver = makeDriver({ kind: 'file', path: YAML_FIXTURE });
    fileJsonDriver = makeDriver({ kind: 'file', path: JSON_FIXTURE });
    await Promise.all([
      collectionDriver.testConnection(),
      fileYamlDriver.testConnection(),
      fileJsonDriver.testConnection(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([collectionDriver?.release(), fileYamlDriver?.release(), fileJsonDriver?.release()]);
  });

  // The query method ignores `values` (no client-side param binding — see
  // MongoSqlDriver.query); inline literals so the SQL is the contract.
  // Each query is shaped to be order-deterministic so byte-equality holds
  // regardless of MongoDB's natural document order.
  it.each([
    ['SELECT email, name, account_id FROM users ORDER BY email ASC'],
    ["SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'"],
    ['SELECT account_id, SUM(amount) AS total FROM orders GROUP BY account_id ORDER BY account_id ASC'],
    ['SELECT _id, tier FROM accounts ORDER BY _id ASC'],
    [
      "SELECT status, COUNT(*) AS c FROM orders WHERE status IN ('paid', 'pending') GROUP BY status ORDER BY status ASC",
    ],
  ])('produces identical results across Collection and File (YAML) modes for: %s', async (sql) => {
    const [collectionRows, fileRows] = await Promise.all([collectionDriver.query(sql), fileYamlDriver.query(sql)]);
    expect(fileRows).toEqual(collectionRows);
  });

  it('JSON file fixture produces identical query results to YAML file fixture', async () => {
    // Same fixture content, different on-disk encoding — driver must produce
    // the same `Catalog` and therefore the same query results.
    const sql = 'SELECT account_id, SUM(amount) AS total FROM orders GROUP BY account_id ORDER BY account_id ASC';
    const [yamlRows, jsonRows] = await Promise.all([fileYamlDriver.query(sql), fileJsonDriver.query(sql)]);
    expect(jsonRows).toEqual(yamlRows);
  });

  it('JSON file fixture produces identical tablesSchema() to YAML file fixture', async () => {
    const [yamlSchema, jsonSchema] = await Promise.all([fileYamlDriver.tablesSchema(), fileJsonDriver.tablesSchema()]);
    expect(jsonSchema).toEqual(yamlSchema);
  });

  it('tablesSchema() is identical across Collection and File modes (T09 db-name normalization)', async () => {
    // The T05/T09 discovery: file-mode catalog is keyed under "" internally,
    // but T09 collapses it to `config.database` in `tablesSchema()`. So the
    // driver-boundary output should be byte-identical across modes.
    const [collectionSchema, fileSchema]: [TablesSchema, TablesSchema] = await Promise.all([
      collectionDriver.tablesSchema(),
      fileYamlDriver.tablesSchema(),
    ]);
    expect(fileSchema).toEqual(collectionSchema);

    // Defensive sanity: file mode must NOT leak the empty-string placeholder
    // out through the driver boundary. If this regresses, T09's collapse step
    // (default_db_for_translate / tablesSchema rewrite) is broken.
    // (Use Object.keys — vitest's `toHaveProperty('')` interprets the empty
    // path as a deep traversal and short-circuits on the root object.)
    const fileDbKeys = Object.keys(fileSchema);
    expect(fileDbKeys).toContain(TEST_DB);
    expect(fileDbKeys).not.toContain('');
  });
});

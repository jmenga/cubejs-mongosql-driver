/**
 * Integration sanity test — verifies the docker-compose harness is up and
 * fixtures were applied. Should pass even before driver implementation begins.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const COMPOSE_FILE = './tests/integration/docker-compose.test.yml';

function mongoshEval(script: string): string {
  return execSync(
    `docker compose -f ${COMPOSE_FILE} exec -T atlas-local mongosh --quiet --eval ${JSON.stringify(script)}`,
    { encoding: 'utf-8' },
  ).trim();
}

describe('docker harness', () => {
  it('atlas-local responds to ping', () => {
    const out = mongoshEval("db.adminCommand('ping').ok");
    expect(out).toContain('1');
  });

  it('seed-data populated the orders collection', () => {
    const out = mongoshEval('db.getSiblingDB("mongosql_test").orders.countDocuments()');
    expect(parseInt(out, 10)).toBeGreaterThan(0);
  });

  it('seed-schemas populated __sql_schemas', () => {
    const out = mongoshEval('db.getSiblingDB("mongosql_test").__sql_schemas.countDocuments()');
    expect(parseInt(out, 10)).toBeGreaterThanOrEqual(3);
  });
});

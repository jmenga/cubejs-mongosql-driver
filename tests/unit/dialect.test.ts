/**
 * Dialect tests for MongoSqlQuery (T12a — static syntax).
 * Run: pnpm test:unit dialect
 *
 * T12a covers identifier quoting, casts, type names, NULL/param tokens, and a
 * passthrough convertTz. Date arithmetic, intervals, seriesSql, dateBin and
 * timeGroupedColumn tests live alongside T12b.
 */
import { describe, expect, it } from 'vitest';

import { MongoSqlQuery } from '../../src/MongoSqlQuery.js';

/**
 * The dialect class is normally instantiated by Cube via its compiler stack.
 * For unit tests we only exercise the static-syntax overrides (which don't
 * touch `this.compilers`/`this.options`). We therefore construct a "bare"
 * instance via `Object.create` to skip the heavyweight constructor and access
 * the prototype methods directly. This is the same trick the upstream
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
      expect(q.timeStampCast("'2026-04-01T00:00:00Z'")).toBe(
        "CAST('2026-04-01T00:00:00Z' AS TIMESTAMP)",
      );
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

  describe('convertTz (TODO — T12b)', () => {
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

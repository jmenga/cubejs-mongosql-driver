/**
 * Failing tests for MongoSqlQuery dialect. Implementation arrives in T12.
 * Run: pnpm test:unit dialect
 *
 * Each `it.todo` becomes a real test in T12 with snapshot assertions on the
 * SQL output the dialect generates for representative Cube measure/dimension
 * combinations.
 */
import { describe } from 'vitest';

describe('MongoSqlQuery dialect', () => {
  describe('identifier quoting', () => {
    it.todo('uses backticks for identifiers (T12)');
    it.todo('escapes backticks inside identifiers (T12)');
  });

  describe('time dimension generation', () => {
    it.todo('emits TIMESTAMP literals (not DATE) (T12)');
    it.todo('uses MongoSQL date-add functions instead of INTERVAL (T12)');
    it.todo('handles dateRange filter for partitioned pre-aggs (T12)');
    it.todo('generates timezone conversion via MongoSQL functions (T12)');
  });

  describe('aggregation', () => {
    it.todo('count(*) compiles to MongoSQL-compatible SUM/COUNT (T12)');
    it.todo('approxCountDistinct uses MongoSQL function (T12)');
  });

  describe('filters and joins', () => {
    it.todo('IN clause works as expected (T12)');
    it.todo('subquery in FROM clause translates correctly (T12)');
    it.todo('JOIN expressions emit MongoSQL-compatible syntax (T12)');
  });

  describe('document/array projection', () => {
    it.todo('nested-field dimensions use dot syntax (T12)');
    it.todo('array dimensions use UNWIND-equivalent (T12)');
  });
});

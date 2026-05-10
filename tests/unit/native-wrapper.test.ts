/**
 * Failing tests for the native binding wrapper. Implementation arrives in T10.
 */
import { describe, it, expect } from 'vitest';
import { MongoSqlClient } from '../../src/native.js';

describe('MongoSqlClient (native wrapper)', () => {
  it('throws Unimplemented from the constructor today (until T10)', () => {
    expect(
      () => new MongoSqlClient({ uri: 'mongodb://localhost', database: 'test' }),
    ).toThrow(/not implemented/);
  });

  it.todo('preserves error code across the FFI boundary (T10)');
  it.todo('passes config through to the native module (T10)');
  it.todo('translates async resolve/reject into JS promise correctly (T10)');
});

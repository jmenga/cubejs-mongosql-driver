import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '../../src/index.js';

describe('sanity', () => {
  it('the test pipeline runs', () => {
    expect(2 + 2).toBe(4);
  });

  it('exports the documented error code list', () => {
    expect(ERROR_CODES).toContain('MONGOSQL_TRANSLATE_FAILED');
    expect(ERROR_CODES).toContain('MONGOSQL_AUTH_FAILED');
    expect(ERROR_CODES.length).toBeGreaterThanOrEqual(9);
  });
});

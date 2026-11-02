import { describe, expect, it } from 'vitest';

import { err, ok } from './result.js';

describe('result', () => {
  it('ok wraps a value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err wraps a domain error', () => {
    expect(err('NOT_FOUND', 'thing is missing')).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'thing is missing' },
    });
  });

  it('narrows via the ok discriminant', () => {
    const result = ok({ id: 'a' });
    expect(result.ok && result.value.id).toBe('a');
  });
});

import { describe, expect, it } from 'vitest';

import { contentDigest } from './digest.js';

describe('contentDigest', () => {
  it('is stable across key reorderings of the same content', () => {
    const a = { title: 'note', tags: ['x', 'y'], meta: { author: 'ann', year: 2026 } };
    const b = { meta: { year: 2026, author: 'ann' }, tags: ['x', 'y'], title: 'note' };
    expect(contentDigest(a)).toBe(contentDigest(b));
  });

  it('changes when a content field changes', () => {
    const a = { title: 'note', body: 'hello' };
    const b = { title: 'note', body: 'hello!' };
    expect(contentDigest(a)).not.toBe(contentDigest(b));
  });

  it('produces a 64-char lowercase hex string', () => {
    expect(contentDigest({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts keys recursively in nested objects and arrays', () => {
    const a = { list: [{ b: 1, a: 2 }] };
    const b = { list: [{ a: 2, b: 1 }] };
    expect(contentDigest(a)).toBe(contentDigest(b));
  });
});

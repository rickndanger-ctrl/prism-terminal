import assert from 'node:assert/strict';
import test from 'node:test';

import { add, multiply } from '../src/calculator.js';

test('multiplication baseline still works', () => {
  assert.equal(multiply(6, 7), 42);
});

test('addition returns the sum of both numbers', () => {
  assert.equal(add(2, 3), 5);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGeminiProbeUsage } from './gemini-probe-usage.mjs';

test('retains explicit zero and modalities without turning missing counters into zero', () => {
  assert.deepEqual(extractGeminiProbeUsage({ promptTokenCount: 0,
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 52 }] }),
  { promptTokenCount: 0, responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 52 }] });
});
test('strips unknown fields including nested text rather than logging raw metadata', () => {
  assert.deepEqual(extractGeminiProbeUsage({ promptTokenCount: 10, secret: 'never output',
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10, text: 'private' }] }),
  { promptTokenCount: 10, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }] });
});
test('rejects malformed, oversized, or absent measurements', () => {
  for (const raw of [undefined, [], {}, { promptTokenCount: -1 }, { totalTokenCount: '10' },
    { responseTokenCount: 1.5 }, { promptTokenCount: 2147483648 },
    { promptTokensDetails: [{ modality: 'secret-text', tokenCount: 1 }] },
    { responseTokensDetails: Array(17).fill({ modality: 'AUDIO', tokenCount: 1 }) }]) {
    assert.equal(extractGeminiProbeUsage(raw), undefined);
  }
});

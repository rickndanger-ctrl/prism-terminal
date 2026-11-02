// Compiled native parser checks only. Every request is deliberately invalid;
// none reaches a Keychain read, update, insertion, or deletion.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';
import console from 'node:console';

const helper = fileURLToPath(new URL('../dist/native/gmail-keychain', import.meta.url));
const cases = [
  ['invalid', ''],
  ['write', '{}'],
  ['write', JSON.stringify({ accessToken: 'fixture-private', refreshToken: 'fixture', expiresAt: true, scopes: ['read'] })],
  ['write', 'x'.repeat(65537)],
];
for (const [action, input] of cases) {
  const result = spawnSync(helper, [action], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, 'invalid_request');
  assert.ok(!result.stdout.includes('fixture-private'));
}
console.log('4 native invalid-input checks passed; no Keychain operation invoked.');

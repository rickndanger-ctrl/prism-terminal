// Real native operations, exclusively in the compile-time acceptance-test slot.
// Refuses an existing entry; never prints data returned by the Keychain helper.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import assert from 'node:assert/strict';
import console from 'node:console';

const helper = fileURLToPath(new URL('../dist/native/gmail-keychain-test', import.meta.url));
function invoke(action, input = '') {
  const result = spawnSync(helper, [action], { input, encoding: 'utf8', timeout: 10000,
    maxBuffer: 70000, env: { PATH: '/usr/bin:/bin' } });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Native test helper returned no valid response.'); }
  if (result.status !== 0) throw new Error(`Native test operation failed: ${parsed.status}; OSStatus ${Number(parsed.code) || 'unavailable'}.`);
  return parsed;
}
const initial = invoke('read');
assert.equal(initial.status, 'missing', 'Acceptance-test slot already exists; it was not changed.');
const grant = { accessToken: `fixture-${randomUUID()}`, refreshToken: `fixture-${randomUUID()}`,
  expiresAt: Date.now() + 60000, scopes: ['fixture-read'] };
let created = false;
try {
  assert.equal(invoke('write', JSON.stringify(grant)).status, 'ok');
  created = true;
  const read = invoke('read');
  assert.equal(read.status, 'ok');
  // Avoid assertion libraries including credential fields in failure messages.
  if (JSON.stringify(read.value) !== JSON.stringify(grant)) {
    for (const key of Object.keys(grant)) {
      if (JSON.stringify(read.value?.[key]) !== JSON.stringify(grant[key])) throw new Error('Keychain round-trip mismatch.');
    }
  }
  const updated = { ...grant, accessToken: `updated-${randomUUID()}` };
  assert.equal(invoke('write', JSON.stringify(updated)).status, 'ok');
  if (invoke('read').value?.accessToken !== updated.accessToken) throw new Error('Keychain update was not persisted.');
} finally {
  if (created) {
    assert.equal(invoke('delete').status, 'ok', 'Acceptance-test entry removal was not confirmed.');
    assert.equal(invoke('read').status, 'missing', 'Acceptance-test entry still exists.');
  }
}
console.log('Native Keychain acceptance passed: create, read, update, delete, and confirmed absence. Production Gmail slot untouched.');

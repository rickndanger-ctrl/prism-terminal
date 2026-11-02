import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GmailStoredGrantSchema, type GmailCredentialStore } from './gmailAccount.js';

type Action = 'read' | 'write' | 'delete';
type Invoke = (action: Action, input?: string) => Promise<unknown>;
const LIMIT = 65536;
const helper = fileURLToPath(new URL('../../../../native/gmail-keychain', import.meta.url));

const invokeNative: Invoke = (action, input) => new Promise((resolve, reject) => {
  const child = spawn(helper, [action], { shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin' } });
  let done = false;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const fail = (): void => {
    if (done) return;
    done = true; clearTimeout(timer); child.kill();
    reject(new Error('Gmail Keychain operation failed. No plaintext fallback was used.'));
  };
  const timer = setTimeout(fail, 10000);
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > LIMIT + 128) { fail(); return; }
    chunks.push(chunk);
  });
  child.on('close', code => {
    if (done) return;
    if (code !== 0) { fail(); return; }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      done = true; clearTimeout(timer); resolve(value);
    } catch { fail(); }
  });
  child.stdin.end(input ?? '');
});

/** Only this trusted host bridge sees native stdout; never forward it to logs,
 * browser responses, the voice model, or the generic computer worker.
 */
export function createGmailKeychainStore(invoke: Invoke = invokeNative): GmailCredentialStore {
  const success = z.object({ status: z.literal('ok') }).strict();
  return {
    async load() {
      const response = await invoke('read');
      if (z.object({ status: z.literal('missing') }).strict().safeParse(response).success) return undefined;
      const parsed = z.object({ status: z.literal('ok'), value: GmailStoredGrantSchema }).strict().safeParse(response);
      if (!parsed.success) throw new Error('Gmail Keychain response was invalid.');
      return parsed.data.value;
    },
    async save(grant) {
      const parsed = GmailStoredGrantSchema.safeParse(grant);
      if (!parsed.success) throw new Error('Gmail credentials were invalid.');
      const input = JSON.stringify(parsed.data);
      if (Buffer.byteLength(input) > LIMIT) throw new Error('Gmail credentials exceeded the storage limit.');
      if (!success.safeParse(await invoke('write', input)).success) throw new Error('Gmail Keychain save was not confirmed.');
    },
    async clear() {
      if (!success.safeParse(await invoke('delete')).success) throw new Error('Gmail Keychain deletion was not confirmed.');
    },
  };
}

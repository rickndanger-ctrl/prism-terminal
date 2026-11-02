import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExecutionPlan } from '@codex-lens/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { applyEdit } from '../src/codex/apply-edit.js';
import type {
  AppServerHandle,
  AppServerMessage,
} from '../src/codex/transport.js';
import { generateExecutionPlan } from '../src/plan-generation.js';
import { SAMPLE_REPO_ID } from '../src/registryConfig.js';
import {
  disposeSandbox,
  prepareSandbox,
  type SandboxHandle,
} from '../src/sandbox.js';

const TIMEOUT_MS = 60_000;
const THREAD_ID = '019f63c2-8b22-7613-89ce-023b27e0be00';
const TURN_ID = '019f63c2-8b22-7613-89ce-023b27e0be01';
const live = new Set<SandboxHandle>();

interface ScriptedClient extends AppServerHandle {
  sent: AppServerMessage[];
}

function createScriptedClient(
  items: readonly Record<string, unknown>[],
  turnStartError?: { code: string | number; message: string },
): ScriptedClient {
  const listeners = new Set<(message: AppServerMessage) => void>();
  const sent: AppServerMessage[] = [];
  const emit = (message: AppServerMessage): void => {
    for (const listener of [...listeners]) listener(message);
  };

  return {
    sent,
    async send(message) {
      sent.push(message);
      if (message.method !== 'turn/start') return;

      queueMicrotask(() => {
        if (turnStartError !== undefined) {
          emit({ jsonrpc: '2.0', id: message.id, error: turnStartError });
          return;
        }
        emit({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            turn: { id: TURN_ID, items: [], status: 'inProgress', error: null },
          },
        });
        for (const item of items) {
          emit({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: { threadId: THREAD_ID, turnId: TURN_ID, item },
          });
        }
        emit({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            threadId: THREAD_ID,
            turn: { id: TURN_ID, items: [...items], status: 'completed', error: null },
          },
        });
      });
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ value: undefined, done: true }) };
    },
    async close() {
      listeners.clear();
    },
  };
}

async function sandbox(): Promise<SandboxHandle> {
  const prepared = await prepareSandbox(SAMPLE_REPO_ID);
  if (!prepared.ok) throw new Error(prepared.error.message);
  live.add(prepared.value);
  return prepared.value;
}

function plan(): ExecutionPlan {
  const generated = generateExecutionPlan(
    {
      text: 'Add a multiply helper and document it.',
      engineeringPlanId: 'engineering-plan-154',
      filesToModify: ['README.md'],
      filesToCreate: ['src/multiply.js'],
    },
    SAMPLE_REPO_ID,
  );
  if (!generated.ok) throw new Error(generated.error.message);
  return generated.value;
}

afterEach(async () => {
  await Promise.all([...live].map(async (handle) => disposeSandbox(handle)));
  live.clear();
});

describe('applyEdit', () => {
  it(
    'runs a read-only Codex turn and materializes agent edits in the sandbox',
    async () => {
      const handle = await sandbox();
      const client = createScriptedClient([
        {
          type: 'agentMessage',
          id: 'agent-1',
          text: JSON.stringify({
            edits: [
              {
                path: 'src/multiply.js',
                content: 'export const multiply = (a, b) => a * b;\n',
              },
              { path: 'README.md', content: '# Calculator\n\nNow with multiply.\n' },
            ],
          }),
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toEqual({
        ok: true,
        value: { changedFiles: ['src/multiply.js', 'README.md'] },
      });
      expect(
        await readFile(path.join(handle.root, 'src', 'multiply.js'), 'utf8'),
      ).toBe('export const multiply = (a, b) => a * b;\n');
      expect(await readFile(path.join(handle.root, 'README.md'), 'utf8')).toContain(
        'Now with multiply.',
      );

      expect(client.sent).toHaveLength(1);
      expect(client.sent[0]).toMatchObject({
        method: 'turn/start',
        params: {
          threadId: THREAD_ID,
          cwd: handle.root,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
        },
      });
    },
    TIMEOUT_MS,
  );

  it(
    'ignores JSON-shaped commentary before a valid edits message',
    async () => {
      const handle = await sandbox();
      const client = createScriptedClient([
        {
          type: 'agentMessage',
          id: 'agent-commentary',
          text: JSON.stringify({ status: 'inspected repository', files: 2 }),
        },
        {
          type: 'agentMessage',
          id: 'agent-edits',
          text: JSON.stringify({
            edits: [
              {
                path: 'src/multiply.js',
                content: 'export const multiply = (a, b) => a * b;\n',
              },
            ],
          }),
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toEqual({
        ok: true,
        value: { changedFiles: ['src/multiply.js'] },
      });
      expect(
        await readFile(path.join(handle.root, 'src', 'multiply.js'), 'utf8'),
      ).toContain('multiply');
    },
    TIMEOUT_MS,
  );

  it(
    'aborts the whole batch when any edits message is malformed, writing nothing',
    async () => {
      const handle = await sandbox();
      const draftPath = path.join(handle.root, 'src', 'multiply.js');
      const client = createScriptedClient([
        {
          type: 'agentMessage',
          id: 'agent-draft',
          text: JSON.stringify({
            edits: [
              {
                path: 'src/multiply.js',
                content: 'export const multiply = (a, b) => a * b;\n',
              },
            ],
          }),
        },
        {
          type: 'agentMessage',
          id: 'agent-malformed-final',
          text: JSON.stringify({ edits: [{ path: 'src/multiply.js' }] }),
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'CODEX_EDIT_INVALID',
          message: 'Codex agent message contained an invalid edits payload',
        },
      });
      expect(existsSync(draftPath)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'drops a drafted file that the final edits message omits, rather than merging it',
    async () => {
      const handle = await sandbox();
      const retracted = path.join(handle.root, 'src', 'multiply.js');
      const client = createScriptedClient([
        {
          // A complete, valid draft. Nothing here is malformed, so the only
          // reason it must not land is that the final message supersedes it.
          type: 'agentMessage',
          id: 'agent-draft',
          text: JSON.stringify({
            edits: [
              {
                path: 'src/multiply.js',
                content: 'export const multiply = (a, b) => a * b;\n',
              },
            ],
          }),
        },
        {
          // The agent reconsidered and dropped src/multiply.js from its final
          // answer. Merging would resurrect it; replacing must not.
          type: 'agentMessage',
          id: 'agent-final',
          text: JSON.stringify({
            edits: [
              { path: 'README.md', content: '# Calculator\n\nNo multiply after all.\n' },
            ],
          }),
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toEqual({
        ok: true,
        value: { changedFiles: ['README.md'] },
      });
      expect(await readFile(path.join(handle.root, 'README.md'), 'utf8')).toContain(
        'No multiply after all.',
      );
      expect(existsSync(retracted)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'materializes a canned write-file tool call through the sandbox helper',
    async () => {
      const handle = await sandbox();
      const client = createScriptedClient([
        {
          type: 'dynamicToolCall',
          id: 'tool-1',
          tool: 'write_file',
          arguments: {
            path: 'src/multiply.js',
            content: 'export function multiply(a, b) { return a * b; }\n',
          },
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toEqual({
        ok: true,
        value: { changedFiles: ['src/multiply.js'] },
      });
      expect(
        await readFile(path.join(handle.root, 'src', 'multiply.js'), 'utf8'),
      ).toContain('return a * b');
    },
    TIMEOUT_MS,
  );

  it(
    'rejects an edit batch atomically when a later path escapes the sandbox',
    async () => {
      const handle = await sandbox();
      const escaped = path.resolve(handle.root, '..', 'escaped-by-codex.txt');
      const valid = path.join(handle.root, 'src', 'multiply.js');
      const client = createScriptedClient([
        {
          type: 'agentMessage',
          id: 'agent-escape',
          text: JSON.stringify({
            edits: [
              {
                path: 'src/multiply.js',
                content: 'export const multiply = (a, b) => a * b;\n',
              },
              { path: '../escaped-by-codex.txt', content: 'pwned\n' },
            ],
          }),
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'SANDBOX_ESCAPE_REJECTED' },
      });
      expect(existsSync(escaped)).toBe(false);
      expect(existsSync(valid)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'rejects an edit batch atomically when a path is outside the plan',
    async () => {
      const handle = await sandbox();
      const valid = path.join(handle.root, 'src', 'multiply.js');
      const client = createScriptedClient([
        {
          type: 'agentMessage',
          id: 'agent-scope',
          text: JSON.stringify({
            edits: [
              {
                path: 'src/multiply.js',
                content: 'export const multiply = (a, b) => a * b;\n',
              },
              // A legal sandbox path — inside the root, tracked, writable — and
              // still not one the plan names. Being writable is not the same as
              // being approved, and this is the difference.
              { path: 'src/calculator.js', content: 'export const add = () => 0;\n' },
            ],
          }),
        },
      ]);

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'PLAN_FILE_OUT_OF_SCOPE' },
      });
      // Nothing landed, not even the edit the plan did name.
      expect(existsSync(valid)).toBe(false);
      expect(
        await readFile(path.join(handle.root, 'src', 'calculator.js'), 'utf8'),
      ).toContain('left - right');
    },
    TIMEOUT_MS,
  );

  it(
    'classifies turn-start credential failures as auth unavailable',
    async () => {
      const handle = await sandbox();
      const client = createScriptedClient([], {
        code: 'auth_required',
        message: 'Login required',
      });

      const result = await applyEdit(client, THREAD_ID, plan(), handle);

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'CODEX_AUTH_UNAVAILABLE',
          message: 'Codex authentication is unavailable: Login required',
        },
      });
    },
    TIMEOUT_MS,
  );

  it('uses the configured full-turn timeout', async () => {
    const handle = await sandbox();
    const client = createScriptedClient([]);
    client.send = async (message) => {
      client.sent.push(message);
    };

    const result = await applyEdit(client, THREAD_ID, plan(), handle, {
      timeoutMs: 10,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CODEX_TURN_TIMED_OUT',
        message: 'Codex did not complete the edit turn within 10ms',
      },
    });
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startAppServer,
  type AppServerHandle,
} from '../src/codex/transport.js';

const handles = new Set<AppServerHandle>();
const echoFixture = fileURLToPath(
  new URL('./fixtures/echo-jsonl.mjs', import.meta.url),
);
const finalMessageFixture = fileURLToPath(
  new URL('./fixtures/final-jsonl.mjs', import.meta.url),
);
const invalidJsonFixture = fileURLToPath(
  new URL('./fixtures/invalid-jsonl-hang.mjs', import.meta.url),
);
const closedStdinFixture = fileURLToPath(
  new URL('./fixtures/closed-stdin.mjs', import.meta.url),
);

afterEach(async () => {
  await Promise.all([...handles].map(async (handle) => handle.close()));
  handles.clear();
});

function startEchoServer(): AppServerHandle {
  const handle = startAppServer({
    command: process.execPath,
    args: [echoFixture],
  });
  handles.add(handle);
  return handle;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(20, remaining));
    });
  }
  return true;
}

describe('Codex app-server stdio transport', () => {
  it('round-trips a newline-framed JSON message through a fake child', async () => {
    const handle = startEchoServer();
    const message = {
      method: 'thread/start',
      id: 10,
      params: { model: 'test-model' },
    };

    const received = new Promise((resolve) => {
      const unsubscribe = handle.onMessage((value) => {
        unsubscribe();
        resolve(value);
      });
    });

    await handle.send(message);

    await expect(received).resolves.toEqual(message);
  });

  it('also exposes received messages as an async iterator', async () => {
    const handle = startEchoServer();
    const message = { method: 'initialized', params: {} };
    const nextMessage = handle[Symbol.asyncIterator]().next();

    await handle.send(message);

    await expect(nextMessage).resolves.toEqual({ value: message, done: false });
  });

  it('delivers a final buffered JSON line before finishing the iterator', async () => {
    const handle = startAppServer({
      command: process.execPath,
      args: [finalMessageFixture],
    });
    handles.add(handle);

    await expect(handle[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: { id: 99, result: 'final message' },
      done: false,
    });
  });

  it('reports an unexpected child exit even when it exits successfully', async () => {
    const handle = startAppServer({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    handles.add(handle);

    await expect(handle.terminated).resolves.toEqual({
      kind: 'exit',
      code: 0,
      signal: null,
      expected: false,
    });
  });

  it('reports a child spawn error without waiting for a request timeout', async () => {
    const handle = startAppServer({
      command: `/definitely-missing-codex-${String(process.pid)}`,
    });
    handles.add(handle);

    await expect(handle.terminated).resolves.toMatchObject({
      kind: 'error',
      expected: false,
      error: { code: 'ENOENT' },
    });
  });

  it('terminates and awaits the child after invalid JSONL finishes messaging', async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'codex-transport-'));
    const shutdownMarker = path.join(tempDirectory, 'terminated');
    const handle = startAppServer({
      command: process.execPath,
      args: [invalidJsonFixture, shutdownMarker],
    });
    handles.add(handle);

    await expect(handle[Symbol.asyncIterator]().next()).rejects.toThrow(
      'Codex app-server emitted invalid JSONL',
    );
    await handle.close();

    await expect(readFile(shutdownMarker, 'utf8')).resolves.toBe('terminated');
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('terminates a POSIX grandchild that survives SIGTERM when the transport closes', async () => {
    if (process.platform === 'win32') return;

    const grandchildSource = `
      process.on('SIGTERM', () => undefined);
      process.stdout.write('ready\\n');
      setInterval(() => undefined, 1_000);
    `;
    const childSource = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      grandchild.stdout.once('data', () => {
        process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n');
        process.exit(0);
      });
    `;
    const handle = startAppServer({
      command: process.execPath,
      args: ['-e', childSource],
    });
    handles.add(handle);

    const ready = await handle[Symbol.asyncIterator]().next();
    expect(ready.done).toBe(false);
    const grandchildPid = (ready.value as { grandchildPid?: unknown }).grandchildPid;
    expect(typeof grandchildPid).toBe('number');
    if (typeof grandchildPid !== 'number') throw new Error('Fixture did not report a grandchild pid');
    expect(processExists(grandchildPid)).toBe(true);

    try {
      await expect(handle.terminated).resolves.toMatchObject({
        kind: 'exit',
        code: 0,
      });
      await handle.close();
      handles.delete(handle);
      await expect(waitForProcessExit(grandchildPid, 2_000)).resolves.toBe(true);
    } finally {
      if (processExists(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    }
  });

  it('rejects an EPIPE write without an unhandled stdin error', async () => {
    const handle = startAppServer({
      command: process.execPath,
      args: [closedStdinFixture],
    });
    handles.add(handle);

    await expect(handle[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: { ready: true },
      done: false,
    });
    await expect(handle.send({ id: 1 })).rejects.toMatchObject({
      code: 'EPIPE',
    });
  });

  it('uses CODEX_APP_SERVER_CMD as the configurable command path', async () => {
    const originalCommand = process.env.CODEX_APP_SERVER_CMD;
    process.env.CODEX_APP_SERVER_CMD = process.execPath;

    try {
      const handle = startAppServer({ args: [echoFixture] });
      handles.add(handle);
      const message = { id: 1, result: { ok: true } };
      const nextMessage = handle[Symbol.asyncIterator]().next();

      await handle.send(message);

      await expect(nextMessage).resolves.toEqual({
        value: message,
        done: false,
      });
    } finally {
      if (originalCommand === undefined) {
        delete process.env.CODEX_APP_SERVER_CMD;
      } else {
        process.env.CODEX_APP_SERVER_CMD = originalCommand;
      }
    }
  });

  it('passes an explicit environment to the child process', async () => {
    const handle = startAppServer({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ value: process.env.CODEX_LENS_TEST_ENV }) + "\\n")',
      ],
      env: { CODEX_LENS_TEST_ENV: 'isolated' },
    });
    handles.add(handle);

    await expect(handle[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: { value: 'isolated' },
      done: false,
    });
  });

  it('only reads the command override and never accesses credential env vars', async () => {
    const sourcePath = fileURLToPath(
      new URL('../src/codex/transport.ts', import.meta.url),
    );
    const source = await readFile(sourcePath, 'utf8');
    const envReads = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(
      ([, name]) => name,
    );

    expect(envReads).toEqual(['CODEX_APP_SERVER_CMD']);
    expect(source).not.toMatch(/OPENAI_API_KEY|TOKEN|PASSWORD|SECRET/);
    expect(source).toContain("stdio: ['pipe', 'pipe', 'ignore']");
    expect(source).not.toContain("stdio: ['pipe', 'pipe', 'inherit']");
  });
});

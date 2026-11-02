import { describe, expect, it } from 'vitest';

import { parseSliceArguments, runCli, type CliIo } from '../src/cli.js';
import type {
  AppServerHandle,
  AppServerMessage,
} from '../src/codex/transport.js';
import { runVerticalSlice } from '../src/orchestrator.js';

interface CapturedIo extends CliIo {
  stdoutLines: string[];
  stderrLines: string[];
}

function captureIo(): CapturedIo {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (message) => stdoutLines.push(message),
    stderr: (message) => stderrLines.push(message),
  };
}

function loggedOutClient(): AppServerHandle & { closed: boolean } {
  const listeners = new Set<(message: AppServerMessage) => void>();
  const client = {
    closed: false as boolean,
    async send(message: AppServerMessage) {
      const respond = (result: Record<string, unknown>): void => {
        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ jsonrpc: '2.0', id: message.id, result });
          }
        });
      };

      if (message.method === 'initialize') {
        respond({ userAgent: 'fake-codex/0.0.0' });
      } else if (message.method === 'getAuthStatus') {
        respond({ authMethod: null, requiresOpenaiAuth: true });
      }
    },
    onMessage(listener: (message: AppServerMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve({ value: undefined, done: true } as const),
      };
    },
    async close() {
      client.closed = true;
      listeners.clear();
    },
  } satisfies AppServerHandle & { closed: boolean };
  return client;
}

describe('parseSliceArguments', () => {
  it('parses a request for a new thread', () => {
    expect(parseSliceArguments(['Fix', 'the', 'calculator'])).toEqual({
      help: false,
      request: 'Fix the calculator',
    });
  });

  it('parses an existing thread id before or after request text', () => {
    expect(
      parseSliceArguments(['Continue', 'the fix', '--thread-id', 'thread-123']),
    ).toEqual({
      help: false,
      request: 'Continue the fix',
      threadId: 'thread-123',
    });
  });

  it('recognizes help without requiring a request', () => {
    expect(parseSliceArguments(['--help'])).toEqual({ help: true });
  });

  it('rejects missing requests, missing values, and unknown options', () => {
    expect(() => parseSliceArguments([])).toThrow('request string is required');
    expect(() => parseSliceArguments(['--thread-id'])).toThrow(
      '--thread-id requires a value',
    );
    expect(() => parseSliceArguments(['--wat', 'fix it'])).toThrow(
      'unknown option: --wat',
    );
  });
});

describe('runCli', () => {
  it('prints help and exits zero without starting Codex', async () => {
    const io = captureIo();
    let starts = 0;

    const exitCode = await runCli(
      ['--help'],
      {
        startClient: () => {
          starts += 1;
          return loggedOutClient();
        },
        runSlice: runVerticalSlice,
      },
      io,
    );

    expect(exitCode).toBe(0);
    expect(starts).toBe(0);
    expect(io.stdoutLines.join('\n')).toContain('Usage: npm run slice');
    expect(io.stderrLines).toEqual([]);
  });

  it('exits non-zero on unavailable auth without fabricating a run', async () => {
    const io = captureIo();
    const client = loggedOutClient();

    const exitCode = await runCli(
      ['Fix add so it returns a sum'],
      { startClient: () => client, runSlice: runVerticalSlice },
      io,
    );

    expect(exitCode).toBe(3);
    expect(client.closed).toBe(true);
    expect(io.stderrLines.join('\n')).toContain(
      'Codex authentication is unavailable',
    );
    expect(io.stderrLines.join('\n')).toContain('No run report was fabricated');
    expect(io.stdoutLines).toEqual([]);
    expect(io.stderrLines.join('\n')).not.toContain('"status"');
    expect(io.stderrLines.join('\n')).not.toContain('"threadId"');
  });
});

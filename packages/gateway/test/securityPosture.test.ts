import { readdir, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyListenOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import {
  GATEWAY_DB_PATH_ENV,
  GATEWAY_HOST,
  installGatewayShutdownHandlers,
  start,
} from '../src/index.js';
import { registerOwnedListenerActivation } from '../src/lifecycle/listenerActivation.js';
import { buildServer } from '../src/server.js';

const TEST_TOKEN = 'security-posture-test-token';

const servers = new Set<ReturnType<typeof buildServer>>();
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  if (originalToken === undefined) {
    delete process.env[GATEWAY_TOKEN_ENV];
  } else {
    process.env[GATEWAY_TOKEN_ENV] = originalToken;
  }
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
});

const EXPECTED_ROUTES = [
  { method: 'GET', url: '/' },
  { method: 'GET', url: '/v1/health' },
  { method: 'GET', url: '/v1/projects' },
  { method: 'POST', url: '/v1/tasks' },
  { method: 'GET', url: '/v1/tasks/:taskId' },
  { method: 'GET', url: '/v1/tasks/:taskId/events' },
] as const;

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const FORBIDDEN_ROUTE_WORDS = /(?:^|[\s/])(?:commit|push|deploy|exec|shell)(?=$|[\s/(])/i;

describe('route surface', () => {
  it('registers exactly the expected routes', async () => {
    const server = buildServer();
    servers.add(server);
    await server.ready();

    for (const route of EXPECTED_ROUTES) {
      expect(
        server.hasRoute({ method: route.method, url: route.url }),
        `expected route ${route.method} ${route.url}`,
      ).toBe(true);
    }

    const routeTree = server.printRoutes({ commonPrefix: false });
    expect('/v1/computer/execute').not.toMatch(FORBIDDEN_ROUTE_WORDS);
    expect('/v1/exec').toMatch(FORBIDDEN_ROUTE_WORDS);
    expect('/v1/shell').toMatch(FORBIDDEN_ROUTE_WORDS);
    expect(routeTree).not.toMatch(FORBIDDEN_ROUTE_WORDS);
  });

  it('exposes no route that could commit, push, or deploy', async () => {
    const server = buildServer();
    servers.add(server);
    await server.ready();

    const forbiddenUrls = [
      '/v1/commit',
      '/v1/push',
      '/v1/deploy',
      '/v1/git/commit',
      '/v1/git/push',
      '/v1/tasks/some-id/commit',
      '/v1/tasks/some-id/push',
      '/v1/tasks/some-id/deploy',
    ];

    for (const url of forbiddenUrls) {
      for (const method of MUTATING_METHODS) {
        expect(
          server.hasRoute({ method, url }),
          `unexpected route ${method} ${url}`,
        ).toBe(false);
      }

      const response = await server.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: {},
      });
      expect(response.statusCode, `POST ${url} must not exist`).toBe(404);
    }
  });

  it('only registers GET routes besides task creation', async () => {
    const server = buildServer();
    servers.add(server);
    await server.ready();

    for (const route of EXPECTED_ROUTES) {
      if (route.method === 'GET') {
        continue;
      }
      expect(route).toEqual({ method: 'POST', url: '/v1/tasks' });
    }
  });
});

describe('localhost-only posture', () => {
  it('pins the listen host to the loopback interface', () => {
    expect(GATEWAY_HOST).toBe('127.0.0.1');
  });

  it('start() passes the loopback host to Fastify without opening a port', async () => {
    const server = buildServer();
    servers.add(server);
    const listenSpy = vi.spyOn(server, 'listen') as unknown as MockInstance<
      (options: FastifyListenOptions) => Promise<string>
    >;
    listenSpy.mockResolvedValue('http://127.0.0.1:0');

    const originalDbPath = process.env[GATEWAY_DB_PATH_ENV];
    process.env[GATEWAY_DB_PATH_ENV] = '/tmp/codex-lens-start-test.sqlite';
    const createServer = vi.fn(() => server);

    try {
      await start(createServer);
    } finally {
      if (originalDbPath === undefined) delete process.env[GATEWAY_DB_PATH_ENV];
      else process.env[GATEWAY_DB_PATH_ENV] = originalDbPath;
    }

    expect(createServer).toHaveBeenCalledWith({ dbPath: '/tmp/codex-lens-start-test.sqlite' });
    expect(listenSpy).toHaveBeenCalledTimes(1);
    const [options] = listenSpy.mock.calls[0] ?? [];
    expect(options).toMatchObject({ host: '127.0.0.1' });
    expect(server.addresses()).toHaveLength(0);
  });

  it('start() rejects and closes the listener when owned-listener activation fails', async () => {
    const server = buildServer();
    servers.add(server);
    registerOwnedListenerActivation(server, 'startup test recovery', () => {
      throw new Error('durable recovery unavailable');
    });
    const originalPort = process.env.CODEX_LENS_PORT;
    process.env.CODEX_LENS_PORT = '0';

    try {
      await expect(start(() => server)).rejects.toThrow(
        'startup test recovery activation failed: durable recovery unavailable',
      );
    } finally {
      if (originalPort === undefined) delete process.env.CODEX_LENS_PORT;
      else process.env.CODEX_LENS_PORT = originalPort;
    }

    expect(server.server.listening).toBe(false);
  });

  it('SIGTERM runs Fastify close so preClose worker cleanup is awaited', async () => {
    const server = buildServer();
    servers.add(server);
    const signals = new EventEmitter();
    const closeSpy = vi.spyOn(server, 'close');
    const controller = installGatewayShutdownHandlers(server, signals);

    signals.emit('SIGTERM');
    await controller.shutdown();

    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

describe('no external network or shell access in gateway source', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));

  async function collectSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectSourceFiles(fullPath)));
      } else if (entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const CHILD_PROCESS_IMPORT = /from\s+['"](?:node:)?child_process['"]/;
  const FORBIDDEN_NETWORK_IMPORT =
    /from\s+['"](?:node:)?(?:net|http|https|dgram|tls)['"]/;
  const PROCESS_SPAWN_CALL = /\bspawn(?:Sync)?\s*\(/;
  const FORBIDDEN_CALLS = [
    /\bexecSync\s*\(/,
    /\bexecFileSync\s*\(/,
    /\brequire\s*\(\s*['"](?:node:)?(?:child_process|net|http|https|dgram|tls)['"]\s*\)/,
  ];

  // The only modules allowed to start a child process: the Codex app-server
  // transport, the fixed read-only Accessibility reader, the computer and
  // Messages controllers, the sandboxed test runner, and the sandbox helper.
  // Each spawns a fixed command with shell:false and never interpolates caller
  // input into executable source. Adding another entry is a posture change.
  const SPAWN_ALLOWLIST = new Set([
    path.join('codex', 'transport.ts'),
    path.join('computer', 'accessibilityInspection.ts'),
    path.join('computer', 'codexComputer.ts'),
    // Fixed TextEdit draft script; literal text is argv, not executable source.
    // textEditDraft.test.ts verifies the exact command/argument boundary.
    path.join('computer', 'textEditDraft.ts'),
    // Fixed native AX insertion helper: JSON stdin, no keystrokes or clipboard.
    path.join('computer', 'focusedText.ts'),
    // Fixed osascript executable and fixed JXA stdin; allowlisted actions/URL
    // arrive only as data argv. desktopActions.test.ts verifies these bounds.
    path.join('computer', 'desktopActions.ts'),
    // Fixed SSH host/runtime; text is bounded JSON stdin, never shell source.
    // commandPadProcess.test.ts verifies command/argument boundaries.
    path.join('computer', 'clefPad.ts'),
    // Fixed macOS open executable, URLSearchParams into a fixed HTTPS origin.
    path.join('routes', 'commandPad.ts'),
    path.join('messages', 'messages.ts'),
    // Fixed native helper, one Gmail slot; credential payload goes via stdin.
    path.join('email', 'gmailKeychain.ts'),
    // One gateway-owned WebRTC bridge, host-configured absolute runtime paths,
    // shell:false, minimal environment, bounded JSON IPC, no action replay.
    path.join('realtime', 'geminiBridgeProcess.ts'),
    // Local CPU TTS only: host-configured absolute executable/script, shell:false,
    // minimal environment, strict bounded stdin, no provider credentials.
    // voice.test.ts checks auth, input boundaries, cancellation and isolation.
    path.join('voice', 'speech.ts'),
    // Fixed read-only security command, one dedicated Gemini Keychain slot;
    // bounded captured output, no shell, caller arguments, or plaintext fallback.
    path.join('realtime', 'geminiRuntime.ts'),
    'test-runner.ts',
    'sandbox.ts',
  ]);

  it('imports no networking or process-spawning modules', async () => {
    const files = await collectSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const relative = path.relative(srcDir, file);
      const maySpawn = SPAWN_ALLOWLIST.has(relative);
      // Authenticated HF signaling is a deliberate loopback-only network
      // boundary. Its fixed destination and credential isolation are tested
      // in huggingface.test.ts; arbitrary route networking stays forbidden.
      expect(
        /\bfetch\s*\(/.test(source) && relative !== path.join('routes', 'realtime.ts'),
        `unapproved fetch in ${relative}`,
      ).toBe(false);
      // OAuth needs one temporary desktop callback listener. Only createServer
      // from node:http is exempt; all other network imports remain forbidden.
      // googleLoopback.test.ts exercises its fixed 127.0.0.1 binding and teardown.
      const networkSource = relative === path.join('email', 'googleLoopback.ts')
        ? source.replace("import { createServer } from 'node:http';", '') : source;
      expect(
        FORBIDDEN_NETWORK_IMPORT.test(networkSource),
        `forbidden network import in ${relative}`,
      ).toBe(false);
      expect(
        CHILD_PROCESS_IMPORT.test(source) && !maySpawn,
        `forbidden child-process import in ${relative}`,
      ).toBe(false);
      expect(
        PROCESS_SPAWN_CALL.test(source) && !maySpawn,
        `forbidden spawn call in ${relative}`,
      ).toBe(false);
      expect(
        /\bexecFile\s*\(/.test(source) && relative !== path.join('computer', 'textEditDraft.ts') && relative !== path.join('routes', 'commandPad.ts'),
        `unapproved execFile in ${relative}`,
      ).toBe(false);
      for (const pattern of FORBIDDEN_CALLS) {
        expect(
          pattern.test(source),
          `forbidden call ${String(pattern)} in ${relative}`,
        ).toBe(false);
      }
    }
  });
});

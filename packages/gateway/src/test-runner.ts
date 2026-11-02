import { spawn } from 'node:child_process';

import { err, ok, type Result } from '@codex-lens/shared';

import { assertCommandAllowed, canonicalizePath } from './registry/index.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface Sandbox {
  /** Directory the test command runs in. The child never sees another cwd. */
  root: string;
  /**
   * Command allowlist. When omitted the caller has already authorized the
   * command; when present, `runTests` re-checks it with the same rule the
   * task runner uses.
   */
  allowedCommands?: readonly string[];
  /** Extra environment for the child, merged over the gateway's own. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock budget for the run. Defaults to two minutes. */
  timeoutMs?: number;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  cancelled: number;
}

export interface TestRun {
  command: string;
  /** True only when the process exited 0 and no test failed or was cancelled. */
  success: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  counts: TestCounts;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface ChildOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The sample repo runs `node --test`, whose summary lines are prefixed with
 * `ℹ` under the default reporter and `#` under the TAP reporter. Anchoring on
 * the label keeps both readable while ignoring per-test result lines.
 */
function readCount(stdout: string, label: string): number | undefined {
  const match = new RegExp(`^\\s*(?:ℹ|#)\\s*${label}\\s+(\\d+)\\s*$`, 'm').exec(
    stdout,
  );
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function parseCounts(stdout: string): Result<TestCounts> {
  const total = readCount(stdout, 'tests');
  const passed = readCount(stdout, 'pass');
  const failed = readCount(stdout, 'fail');
  if (total === undefined || passed === undefined || failed === undefined) {
    return err(
      'TEST_OUTPUT_UNPARSABLE',
      'Test output did not contain the expected "tests"/"pass"/"fail" summary',
    );
  }

  return ok({
    total,
    passed,
    failed,
    skipped: readCount(stdout, 'skipped') ?? 0,
    todo: readCount(stdout, 'todo') ?? 0,
    cancelled: readCount(stdout, 'cancelled') ?? 0,
  });
}

function spawnCommand(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Result<ChildOutcome>> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    const settle = (result: Result<ChildOutcome>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    child.on('error', (error) => {
      settle(err('TEST_COMMAND_FAILED', errorMessage(error)));
    });

    // `close` rather than `exit`: the stdio pipes must be drained before the
    // captured output can be parsed.
    child.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        settle(
          err(
            'TEST_COMMAND_TIMED_OUT',
            `Test command exceeded its ${timeoutMs}ms budget`,
          ),
        );
        return;
      }
      settle(
        ok({
          exitCode: code,
          signal,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
        }),
      );
    });
  });
}

/**
 * Runs a repository's test command as a real child process inside `sandbox`
 * and reports its structured outcome. Non-zero exits are a successful *run*
 * reporting failing tests, not a `runTests` error; only a run that could not
 * be executed or read back returns an error Result.
 */
export async function runTests(
  sandbox: Sandbox,
  command: string,
): Promise<Result<TestRun>> {
  const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
  if (file === undefined) {
    return err('INVALID_TEST_COMMAND', 'Test command must not be empty');
  }

  if (sandbox.allowedCommands !== undefined) {
    const allowed = assertCommandAllowed(command, sandbox.allowedCommands);
    if (!allowed.ok) {
      return allowed;
    }
  }

  let cwd: string;
  try {
    cwd = canonicalizePath(sandbox.root);
  } catch {
    return err(
      'INVALID_SANDBOX_ROOT',
      `Sandbox root does not exist or cannot be resolved: "${sandbox.root}"`,
    );
  }

  const startedAt = performance.now();
  const outcome = await spawnCommand(
    file,
    args,
    cwd,
    { ...process.env, ...sandbox.env },
    sandbox.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const durationMs = performance.now() - startedAt;
  if (!outcome.ok) {
    return outcome;
  }

  const counts = parseCounts(outcome.value.stdout);
  if (!counts.ok) {
    return counts;
  }

  return ok({
    command,
    success:
      outcome.value.exitCode === 0 &&
      counts.value.failed === 0 &&
      counts.value.cancelled === 0,
    exitCode: outcome.value.exitCode,
    signal: outcome.value.signal,
    counts: counts.value,
    stdout: outcome.value.stdout,
    stderr: outcome.value.stderr,
    durationMs,
  });
}

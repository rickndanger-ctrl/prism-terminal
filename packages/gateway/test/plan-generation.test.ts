import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  executionPlanSchema,
  parseExecutionPlan,
  toJSON,
  type ExecutionPlan,
} from '@codex-lens/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  generateExecutionPlan,
  SAMPLE_REPO_TEST_COMMAND,
  type ExecutionPlanRequest,
} from '../src/plan-generation.js';
import {
  CODEX_LENS_REPO_ID,
  CODEX_LENS_REPO_ROOT,
  SAMPLE_REPO_ID,
  SAMPLE_REPO_ROOT,
} from '../src/registryConfig.js';

const canonicalSampleRoot = realpathSync.native(SAMPLE_REPO_ROOT);

const request: ExecutionPlanRequest = {
  text: 'Fix add() in the calculator so it returns the sum instead of the difference.',
  engineeringPlanId: 'engineering-plan-151',
  filesToModify: ['src/calculator.js'],
};

/** Paths created inside the sample repo by a test, removed afterwards. */
const litter: string[] = [];

function inSampleRepo(...segments: string[]): string {
  const created = path.join(canonicalSampleRoot, ...segments);
  litter.push(created);
  return created;
}

afterEach(() => {
  while (litter.length > 0) {
    rmSync(litter.pop() as string, { force: true, recursive: true });
  }
});

function generateOrThrow(override: Partial<ExecutionPlanRequest> = {}): ExecutionPlan {
  const result = generateExecutionPlan({ ...request, ...override }, SAMPLE_REPO_ID);
  if (!result.ok) {
    throw new Error(`expected a plan, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

describe('generateExecutionPlan', () => {
  it('produces a plan that validates against the shared execution plan schema', () => {
    const plan = generateOrThrow();

    expect(executionPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.engineeringPlanId).toBe('engineering-plan-151');
    expect(plan.executionStatus).toBe('Pending');
    expect(plan.version).toBe(1);
  });

  it('computes a content digest that re-verifies when the plan is parsed back', () => {
    const plan = generateOrThrow();

    const reparsed = parseExecutionPlan(JSON.parse(JSON.stringify(toJSON(plan))));

    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.value.contentDigest).toBe(plan.contentDigest);
    }
  });

  it('rejects a plan whose digest no longer matches its content', () => {
    const plan = generateOrThrow();

    const tampered = parseExecutionPlan({
      ...toJSON(plan),
      estimatedRisk: plan.estimatedRisk === 'High' ? 'Low' : 'High',
    });

    expect(tampered.ok).toBe(false);
    if (!tampered.ok) {
      expect(tampered.error.code).toBe('EXECUTION_PLAN_DIGEST_MISMATCH');
    }
  });

  it('resolves every file it names inside the registered sample repo', () => {
    const plan = generateOrThrow({
      filesToModify: ['src/calculator.js'],
      filesToCreate: ['src/subtract.js'],
      filesToDelete: ['README.md'],
    });

    const files = [
      ...plan.filesToModify,
      ...plan.filesToCreate,
      ...plan.filesToDelete,
    ];

    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(file.startsWith(`${canonicalSampleRoot}${path.sep}`)).toBe(true);
    }
    expect(plan.filesToModify).toEqual([
      path.join(canonicalSampleRoot, 'src/calculator.js'),
    ]);
  });

  it("expects the fixture's test command", () => {
    expect(generateOrThrow().expectedCommands).toEqual([SAMPLE_REPO_TEST_COMMAND]);
    expect(SAMPLE_REPO_TEST_COMMAND).toBe('npm test');
  });

  it('estimates risk, complexity and duration for the requested change', () => {
    const oneFile = generateOrThrow();
    expect(oneFile.estimatedRisk).toBe('Low');
    expect(oneFile.estimatedComplexity).toBe('Low');
    expect(oneFile.estimatedDuration).toBeGreaterThan(0);

    const withDeletion = generateOrThrow({ filesToDelete: ['README.md'] });
    expect(withDeletion.estimatedRisk).toBe('High');
    expect(withDeletion.estimatedComplexity).toBe('Medium');
    expect(withDeletion.estimatedDuration).toBeGreaterThan(oneFile.estimatedDuration);
  });

  it('walks the requested change through steps that bracket it with test runs', () => {
    const steps = generateOrThrow().implementationSteps;

    expect(steps[0]).toContain('Fix add()');
    expect(steps[1]).toContain(SAMPLE_REPO_TEST_COMMAND);
    expect(steps.at(-1)).toContain(SAMPLE_REPO_TEST_COMMAND);
    expect(steps.some((step) => step.includes('src/calculator.js'))).toBe(true);
  });
});

/**
 * POSIX single-quoting, written out independently of the implementation so the
 * tests below assert on the shell's rules rather than on the code under test.
 */
function quote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Runs the strategy's command list in a real shell with `git` and `rm` shimmed
 * to record their arguments instead of doing anything, and reports what each
 * was actually invoked with.
 *
 * This is what makes the quoting testable: the shell, not a regex, decides
 * where one command ends and the next begins, so a filename that smuggles in
 * `; rm -rf ~` would show up here as an extra recorded command.
 */
function runRollback(rollbackStrategy: string): Array<{ cmd: string; args: string[] }> {
  const match = /run: (.*)\. Then re-run/s.exec(rollbackStrategy);
  if (match === null) {
    throw new Error(`no command list in rollback strategy: ${rollbackStrategy}`);
  }

  const record = (name: string): string =>
    `${name}() { printf '${name}\\0'; for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\036'; }`;
  const out = execFileSync(
    '/bin/sh',
    ['-c', `${record('git')}\n${record('rm')}\n${match[1]}`],
    { encoding: 'utf8' },
  );

  return out
    .split('\x1e')
    .filter((invocation) => invocation.length > 0)
    .map((invocation) => {
      const parts = invocation.split('\0').slice(0, -1);
      return { cmd: parts[0] ?? '', args: parts.slice(1) };
    });
}

describe('generateExecutionPlan rollback strategy', () => {
  it('scopes rollback to the plan files and never restores the whole tree', () => {
    const plan = generateOrThrow({
      filesToModify: ['src/calculator.js'],
      filesToCreate: ['src/subtract.js'],
      filesToDelete: ['README.md'],
    });

    const { rollbackStrategy } = plan;
    expect(rollbackStrategy).not.toContain('git restore .');
    expect(rollbackStrategy).not.toMatch(/git\s+(restore|checkout)\s+[.*]/);

    for (const file of [...plan.filesToModify, ...plan.filesToDelete]) {
      expect(rollbackStrategy).toContain(`git restore -- ${quote(file)}`);
    }
    for (const file of plan.filesToCreate) {
      // A created file has nothing in HEAD to restore, so it is removed.
      expect(rollbackStrategy).toContain(`rm -f ${quote(file)}`);
      expect(rollbackStrategy).not.toContain(`git restore -- ${quote(file)}`);
    }

    // One command per plan file and no others: the strategy touches the files
    // this plan names and nothing else.
    expect(occurrences(rollbackStrategy, 'git restore')).toBe(
      plan.filesToModify.length + plan.filesToDelete.length,
    );
    expect(occurrences(rollbackStrategy, 'rm -f')).toBe(plan.filesToCreate.length);
    expect(rollbackStrategy).toContain(SAMPLE_REPO_TEST_COMMAND);
  });

  it('shell-quotes a hostile filename instead of letting it break out', () => {
    // A legal filename that closes the quote, runs a command and reopens it.
    const hostile = "pwn'; rm -rf ~; echo '.js";
    const hostilePath = inSampleRepo(hostile);
    writeFileSync(hostilePath, 'export const pwn = true;\n');

    const plan = generateOrThrow({ filesToModify: ['src/calculator.js', hostile] });

    const { rollbackStrategy } = plan;
    expect(plan.filesToModify).toContain(hostilePath);
    expect(rollbackStrategy).toContain(`git restore -- ${quote(hostilePath)}`);

    // A real shell reads the hostile path as one argument: the injected
    // `rm -rf ~` stays inert data inside the filename rather than becoming a
    // command of its own, so only the plan's own two restores ever run.
    expect(runRollback(rollbackStrategy)).toEqual([
      { cmd: 'git', args: ['restore', '--', path.join(canonicalSampleRoot, 'src/calculator.js')] },
      { cmd: 'git', args: ['restore', '--', hostilePath] },
    ]);
  });

  it('shell-quotes a created file whose name contains a quote', () => {
    const hostile = "new'; touch owned; echo '.js";

    const plan = generateOrThrow({
      filesToModify: [],
      filesToCreate: [hostile],
    });

    const expectedPath = path.join(canonicalSampleRoot, hostile);
    expect(plan.rollbackStrategy).toContain(`rm -f ${quote(expectedPath)}`);

    // The `touch owned` hidden in the filename never runs as a command.
    expect(runRollback(plan.rollbackStrategy)).toEqual([
      { cmd: 'rm', args: ['-f', expectedPath] },
    ]);
  });
});

describe('generateExecutionPlan conflicting targets', () => {
  it('rejects a file listed to both modify and delete', () => {
    const result = generateExecutionPlan(
      {
        ...request,
        filesToModify: ['src/calculator.js'],
        filesToDelete: ['src/calculator.js'],
      },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CONFLICTING_FILE');
    }
  });

  it('rejects the same file listed twice in one group', () => {
    const result = generateExecutionPlan(
      { ...request, filesToModify: ['src/calculator.js', 'src/calculator.js'] },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CONFLICTING_FILE');
    }
  });

  it('catches a conflict spelled two different ways', () => {
    const result = generateExecutionPlan(
      {
        ...request,
        filesToModify: ['src/calculator.js'],
        filesToDelete: ['./src/../src/calculator.js'],
      },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CONFLICTING_FILE');
    }
  });

  it('rejects the same file listed twice to create', () => {
    const result = generateExecutionPlan(
      { ...request, filesToModify: [], filesToCreate: ['src/new.js', 'src/new.js'] },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CONFLICTING_FILE');
    }
  });

  it('rejects creating a file the plan also modifies, because it already exists', () => {
    const result = generateExecutionPlan(
      {
        ...request,
        filesToModify: ['src/calculator.js'],
        filesToCreate: ['src/calculator.js'],
      },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREATE_TARGET_EXISTS');
    }
  });
});

describe('generateExecutionPlan target safety', () => {
  it('rejects a create target whose parent symlinks out of the repo', () => {
    const outside = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'escape-'));
    const link = inSampleRepo('escape-hatch');
    symlinkSync(outside, link, 'dir');

    try {
      const result = generateExecutionPlan(
        { ...request, filesToModify: [], filesToCreate: ['escape-hatch/pwned.js'] },
        SAMPLE_REPO_ID,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
      }
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects a create target that already exists on disk', () => {
    const existing = inSampleRepo('already-here.js');
    writeFileSync(existing, 'export const already = true;\n');

    const result = generateExecutionPlan(
      { ...request, filesToModify: [], filesToCreate: ['already-here.js'] },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREATE_TARGET_EXISTS');
    }
  });

  it('rejects a create target that is an in-repo symlink to a file outside the repo', () => {
    const outside = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'escape-'));
    const outsideFile = path.join(outside, 'target.js');
    writeFileSync(outsideFile, 'export const outside = true;\n');
    const link = inSampleRepo('linked.js');
    symlinkSync(outsideFile, link, 'file');

    try {
      const result = generateExecutionPlan(
        { ...request, filesToModify: [], filesToCreate: ['linked.js'] },
        SAMPLE_REPO_ID,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_CREATE_TARGET_EXISTS');
      }
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects a file to modify that symlinks out of the repo', () => {
    const outside = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'escape-'));
    const outsideFile = path.join(outside, 'secrets.js');
    writeFileSync(outsideFile, 'export const secret = true;\n');
    const link = inSampleRepo('secrets.js');
    symlinkSync(outsideFile, link, 'file');

    try {
      const result = generateExecutionPlan({ ...request, filesToModify: ['secrets.js'] }, SAMPLE_REPO_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
      }
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects a file that escapes the repo via ".."', () => {
    const result = generateExecutionPlan(
      { ...request, filesToModify: ['../../package.json'] },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
    }
  });

  it('rejects an absolute path pointing into the codex-lens repo', () => {
    const result = generateExecutionPlan(
      { ...request, filesToModify: [path.join(CODEX_LENS_REPO_ROOT, 'package.json')] },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TARGET_NOT_EDITABLE');
    }
  });

  it('rejects a file to modify that does not exist', () => {
    const result = generateExecutionPlan(
      { ...request, filesToModify: ['src/nowhere.js'] },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TARGET_PATH');
    }
  });

  it('rejects a directory named as a file to modify', () => {
    const result = generateExecutionPlan({ ...request, filesToModify: ['src'] }, SAMPLE_REPO_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_FILE_NOT_A_FILE');
    }
  });
});

describe('generateExecutionPlan request and repo validation', () => {
  it('rejects an unregistered repo', () => {
    const result = generateExecutionPlan(request, 'not-a-registered-repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN_REPO');
    }
  });

  it('rejects the registered but non-editable codex-lens repo', () => {
    const result = generateExecutionPlan(
      { ...request, filesToModify: ['package.json'] },
      CODEX_LENS_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_REPO_NOT_EDITABLE');
    }
  });

  it('rejects an empty request text', () => {
    const result = generateExecutionPlan({ ...request, text: '   ' }, SAMPLE_REPO_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PLAN_REQUEST');
    }
  });

  it('rejects a request that links no engineering plan', () => {
    const result = generateExecutionPlan(
      { ...request, engineeringPlanId: '' },
      SAMPLE_REPO_ID,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PLAN_REQUEST');
    }
  });

  it('rejects a request that touches no files', () => {
    const result = generateExecutionPlan({ ...request, filesToModify: [] }, SAMPLE_REPO_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_NO_FILES');
    }
  });
});

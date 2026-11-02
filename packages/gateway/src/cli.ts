#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from 'node:url';

import {
  ApprovalStatus,
  ApprovalTargetType,
  createApprovalContract,
  type ApprovalContract,
  type ExecutionPlan,
} from '@codex-lens/shared';

import { CODEX_AUTH_UNAVAILABLE } from './codex/client.js';
import { startAppServer, type AppServerHandle } from './codex/transport.js';
import { runVerticalSlice, type VerticalSliceOptions } from './orchestrator.js';
import { SAMPLE_REPO_ID } from './registryConfig.js';
import { disposeSandbox } from './sandbox.js';

const SAMPLE_FILE = 'src/calculator.js';
const ENGINEERING_PLAN_ID = 'gateway-sample-slice';

export const SLICE_USAGE = `Usage: npm run slice -- [--thread-id <id>] <request>

Run one approved Codex vertical slice against the registered sample repository.

Arguments:
  <request>          Requested change (quote it when it contains spaces)
  --thread-id <id>  Resume an existing Codex thread instead of creating one
  -h, --help         Show this help

Environment:
  CODEX_APP_SERVER_CMD  Codex executable to launch (default: codex)`;

export type SliceArguments =
  { help: true } | { help: false; request: string; threadId?: string };

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliDependencies {
  startClient(): AppServerHandle;
  runSlice(options: VerticalSliceOptions): ReturnType<typeof runVerticalSlice>;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const defaultDependencies: CliDependencies = {
  startClient: () => startAppServer(),
  runSlice: runVerticalSlice,
};

function requiredValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseSliceArguments(args: readonly string[]): SliceArguments {
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }

  let threadId: string | undefined;
  const requestParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--thread-id') {
      if (threadId !== undefined) {
        throw new Error('--thread-id may only be provided once');
      }
      threadId = requiredValue(args, index, '--thread-id');
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    }
    requestParts.push(argument);
  }

  const request = requestParts.join(' ').trim();
  if (request.length === 0) {
    throw new Error('a request string is required');
  }

  return {
    help: false,
    request,
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function approve(plan: ExecutionPlan): ApprovalContract {
  const approval = createApprovalContract({
    approvalId: `slice-${plan.executionPlanId}`,
    approvedBy: 'gateway-slice-cli',
    approvalTimestamp: new Date().toISOString(),
    approvalType: 'ExecutionPlanApproval',
    notes: 'Operator invoked the local sample-repository vertical slice.',
    approvalStatus: ApprovalStatus.Approved,
    target: {
      targetType: ApprovalTargetType.ExecutionPlan,
      targetId: plan.executionPlanId,
      targetVersion: plan.version,
      targetContentDigest: plan.contentDigest,
    },
  });
  if (!approval.ok) {
    throw new Error(approval.error.message);
  }
  return approval.value;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
  io: CliIo = defaultIo,
): Promise<number> {
  let parsed: SliceArguments;
  try {
    parsed = parseSliceArguments(args);
  } catch (error) {
    io.stderr(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    io.stderr(SLICE_USAGE);
    return 2;
  }

  if (parsed.help) {
    io.stdout(SLICE_USAGE);
    return 0;
  }

  let client: AppServerHandle;
  try {
    client = dependencies.startClient();
  } catch (error) {
    io.stderr(
      `Could not start Codex app-server: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  try {
    const result = await dependencies.runSlice({
      request: {
        text: parsed.request,
        engineeringPlanId: ENGINEERING_PLAN_ID,
        filesToModify: [SAMPLE_FILE],
      },
      repoId: SAMPLE_REPO_ID,
      approval: approve,
      client,
      ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
    });

    if (!result.ok) {
      if (result.error.code === CODEX_AUTH_UNAVAILABLE) {
        io.stderr(
          'Codex authentication is unavailable. Authenticate the configured Codex command (normally with `codex login`) and retry. No run report was fabricated.',
        );
        return 3;
      }
      io.stderr(`Slice failed (${result.error.code}): ${result.error.message}`);
      return 1;
    }

    const report = result.value;
    io.stdout(
      JSON.stringify(
        {
          status: report.status,
          threadId: report.threadId,
          planDigest: report.planDigest,
          appliedFiles: report.appliedFiles,
          diff: report.diff,
          finalTests: report.finalTests,
          rolledBack: report.rolledBack,
        },
        null,
        2,
      ),
    );

    const disposed = await disposeSandbox(report.sandbox);
    if (!disposed.ok) {
      io.stderr(
        `Slice completed, but its sandbox could not be removed (${disposed.error.code}): ${disposed.error.message}`,
      );
      return 1;
    }
    return report.status === 'Complete' ? 0 : 1;
  } finally {
    await client.close().catch((error: unknown) => {
      io.stderr(
        `Could not stop Codex app-server: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  return script !== undefined && import.meta.url === pathToFileURL(script).href;
}

if (isEntrypoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}

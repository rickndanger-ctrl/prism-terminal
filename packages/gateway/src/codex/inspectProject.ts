import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { err, ok, type Result } from '@codex-lens/shared';

import type { RegistryRecord } from '../registry/projectRegistry.js';
import {
  CODEX_AUTH_UNAVAILABLE,
  createThread,
  initialize,
  isAuthUnavailable,
} from './client.js';
import { startAppServer, type AppServerHandle, type AppServerMessage } from './transport.js';

const DEFAULT_TIMEOUT_MS = 2 * 60_000;

export interface CodexProjectInspection {
  projectId: string;
  projectName: string;
  summary: string;
  files: string[];
  readOnly: true;
}

export interface InspectCodexProjectOptions {
  startClient?: () => AppServerHandle;
  timeoutMs?: number;
}

interface TurnOutcome {
  messages: AppServerMessage[];
  turn: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectionInstructions(project: RegistryRecord, question: string): string {
  return [
    'Inspect the approved repository in read-only mode and answer the user question.',
    'Do not edit files, run mutating commands, install anything, or use network access.',
    'Base the answer on files actually present in the repository. Distinguish verified findings from inference.',
    'Return only JSON in this exact shape: {"summary":"plain-language answer","files":["repo/relative/path"]}.',
    'List only the most relevant repository-relative files you actually inspected. Never return absolute paths.',
    `Approved project: ${project.displayName} (${project.id})`,
    `Question: ${question}`,
  ].join('\n');
}

async function runInspectionTurn(
  client: AppServerHandle,
  threadId: string,
  project: RegistryRecord,
  question: string,
  timeoutMs: number,
): Promise<Result<TurnOutcome>> {
  const requestId = `inspect-project-${randomUUID()}`;
  const messages: AppServerMessage[] = [];

  return new Promise((resolve) => {
    let settled = false;
    let turn: Record<string, unknown> | undefined;
    const completions = new Map<string, AppServerMessage>();

    const settle = (result: Result<TurnOutcome>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const finishIfReady = (): void => {
      if (turn === undefined || typeof turn.id !== 'string') return;
      const completed = completions.get(turn.id);
      if (completed === undefined || !isRecord(completed.params)) return;
      const completedTurn = completed.params.turn;
      if (!isRecord(completedTurn)) return;
      settle(ok({ messages, turn: completedTurn }));
    };

    const timer = setTimeout(() => {
      settle(err('CODEX_INSPECTION_TIMED_OUT', `Codex did not finish repository inspection within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const unsubscribe = client.onMessage((message) => {
      messages.push(message);
      if (message.id === requestId) {
        if (isRecord(message.error)) {
          const detail = typeof message.error.message === 'string'
            ? message.error.message
            : 'Codex rejected the repository inspection';
          settle(isAuthUnavailable(message.error.code, detail)
            ? err(CODEX_AUTH_UNAVAILABLE, `Codex authentication is unavailable: ${detail}`)
            : err('CODEX_INSPECTION_FAILED', detail));
          return;
        }
        const result = message.result;
        const responseTurn = isRecord(result) ? result.turn : undefined;
        if (!isRecord(responseTurn) || typeof responseTurn.id !== 'string') {
          settle(err('CODEX_PROTOCOL_ERROR', 'Codex answered "turn/start" without a turn id'));
          return;
        }
        turn = responseTurn;
        finishIfReady();
        return;
      }
      if (message.method !== 'turn/completed' || !isRecord(message.params)) return;
      if (message.params.threadId !== threadId) return;
      const completedTurn = message.params.turn;
      if (!isRecord(completedTurn) || typeof completedTurn.id !== 'string') return;
      if (turn !== undefined && completedTurn.id !== turn.id) return;
      completions.set(completedTurn.id, message);
      finishIfReady();
    });

    client.send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'turn/start',
      params: {
        threadId,
        input: [{
          type: 'text',
          text: inspectionInstructions(project, question),
          text_elements: [],
        }],
        cwd: project.path,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['summary', 'files'],
          properties: {
            summary: { type: 'string', minLength: 1 },
            files: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }).catch((error: unknown) => {
      settle(err('CODEX_TRANSPORT_FAILED', `Could not start repository inspection: ${errorMessage(error)}`));
    });
  });
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

function completedItems(outcome: TurnOutcome, threadId: string): unknown[] {
  const items: unknown[] = [];
  const seen = new Set<string>();
  const add = (item: unknown): void => {
    const id = isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
    if (id !== undefined && seen.has(id)) return;
    if (id !== undefined) seen.add(id);
    items.push(item);
  };
  for (const message of outcome.messages) {
    if (message.method !== 'item/completed' || !isRecord(message.params)) continue;
    if (message.params.threadId !== threadId || message.params.turnId !== outcome.turn.id) continue;
    add(message.params.item);
  }
  if (Array.isArray(outcome.turn.items)) {
    for (const item of outcome.turn.items) add(item);
  }
  return items;
}

function isSafeRelativeFile(value: string): boolean {
  if (path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function readInspection(outcome: TurnOutcome, threadId: string): Result<{ summary: string; files: string[] }> {
  for (const item of completedItems(outcome, threadId).reverse()) {
    if (!isRecord(item) || item.type !== 'agentMessage' || typeof item.text !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = parseJson(item.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.summary !== 'string' || !Array.isArray(parsed.files)) continue;
    const summary = parsed.summary.trim();
    const files = parsed.files.filter((file): file is string =>
      typeof file === 'string' && file.trim().length > 0 && isSafeRelativeFile(file.trim())
    ).map((file) => path.normalize(file.trim()));
    if (summary.length > 0 && files.length === parsed.files.length) {
      return ok({ summary, files: [...new Set(files)].slice(0, 20) });
    }
  }
  return err('CODEX_INSPECTION_INVALID', 'Codex completed inspection without a valid structured answer');
}

export async function inspectCodexProject(
  project: RegistryRecord,
  question: string,
  options: InspectCodexProjectOptions = {},
): Promise<Result<CodexProjectInspection>> {
  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length === 0) {
    return err('INVALID_CODEX_INSPECTION', 'A repository question is required');
  }

  let client: AppServerHandle;
  try {
    client = (options.startClient ?? (() => startAppServer({ cwd: project.path })))();
  } catch (error) {
    return err('CODEX_START_FAILED', errorMessage(error));
  }

  try {
    const initialized = await initialize(client, { timeoutMs: options.timeoutMs });
    if (!initialized.ok) return initialized;
    const thread = await createThread(client, { cwd: project.path, timeoutMs: options.timeoutMs });
    if (!thread.ok) return thread;
    const outcome = await runInspectionTurn(
      client,
      thread.value.threadId,
      project,
      trimmedQuestion,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!outcome.ok) return outcome;
    if (outcome.value.turn.status !== 'completed') {
      return err('CODEX_INSPECTION_FAILED', `Codex inspection ended with status "${String(outcome.value.turn.status)}"`);
    }
    const inspection = readInspection(outcome.value, thread.value.threadId);
    if (!inspection.ok) return inspection;
    return ok({
      projectId: project.id,
      projectName: project.displayName,
      summary: inspection.value.summary,
      files: inspection.value.files,
      readOnly: true,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

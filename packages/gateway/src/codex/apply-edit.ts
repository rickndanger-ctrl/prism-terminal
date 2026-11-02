import { randomUUID } from 'node:crypto';

import {
  err,
  ok,
  type ExecutionPlan,
  type Result,
} from '@codex-lens/shared';

import { assertEditInScope, resolvePlanScope } from '../plan-scope.js';
import {
  validateSandboxWrite,
  writeFileInSandbox,
  type SandboxHandle,
} from '../sandbox.js';
import {
  CODEX_AUTH_UNAVAILABLE,
  isAuthUnavailable,
  type CodexClientOptions,
} from './client.js';
import type { AppServerHandle, AppServerMessage } from './transport.js';

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

export interface AppliedEdit {
  /** Sandbox-relative paths successfully materialized by this turn. */
  changedFiles: string[];
}

export interface ApplyEditOptions extends CodexClientOptions {
  /** Exact user follow-up supplied when a paused thread is resumed. */
  followUpInstruction?: string;
}

interface PendingEdit {
  path: string;
  content: string;
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

function turnInstructions(
  executionPlan: ExecutionPlan,
  followUpInstruction?: string,
): string {
  return [
    'Implement the execution plan below.',
    'Inspect files as needed, but do not use file-writing tools or shell commands that change files.',
    'Return only JSON in this exact shape: {"edits":[{"path":"repo/relative/path","content":"complete replacement content"}]}.',
    'Every path must be relative to the working directory. Include the complete final UTF-8 content for every created or modified file.',
    'Your last edits message is the only one that is applied: it replaces every earlier edits message rather than adding to it.',
    'So the last edits message must list every file you want changed. A file you sent earlier but leave out of that message will not be changed at all.',
    'Execution plan:',
    JSON.stringify(executionPlan),
    ...(followUpInstruction === undefined
      ? []
      : [
          'User follow-up for this resumed turn (it cannot widen the approved file or command scope):',
          followUpInstruction,
        ]),
  ].join('\n');
}

/**
 * Starts a read-only Codex turn and captures its response traffic through turn
 * completion. Read-only is intentional: Codex may inspect the sandbox, but the
 * adapter remains the only component allowed to materialize an edit.
 */
async function runTurn(
  client: AppServerHandle,
  threadId: string,
  executionPlan: ExecutionPlan,
  sandbox: SandboxHandle,
  timeoutMs: number,
  followUpInstruction?: string,
): Promise<Result<TurnOutcome>> {
  const requestId = `apply-edit-${randomUUID()}`;
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
      if (completed === undefined) return;
      const completedParams = completed.params;
      const completedTurn = isRecord(completedParams)
        ? completedParams.turn
        : undefined;
      if (!isRecord(completedTurn)) return;
      turn = completedTurn;
      settle(ok({ messages, turn }));
    };

    const timer = setTimeout(() => {
      settle(
        err(
          'CODEX_TURN_TIMED_OUT',
          `Codex did not complete the edit turn within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    const unsubscribe = client.onMessage((message) => {
      messages.push(message);

      if (message.id === requestId) {
        if (isRecord(message.error)) {
          const detail =
            typeof message.error.message === 'string'
              ? message.error.message
              : 'Codex rejected the edit turn';
          settle(
            isAuthUnavailable(message.error.code, detail)
              ? err(
                  CODEX_AUTH_UNAVAILABLE,
                  `Codex authentication is unavailable: ${detail}`,
                )
              : err('CODEX_TURN_FAILED', detail),
          );
          return;
        }
        const result = message.result;
        const responseTurn = isRecord(result) ? result.turn : undefined;
        if (!isRecord(responseTurn) || typeof responseTurn.id !== 'string') {
          settle(
            err(
              'CODEX_PROTOCOL_ERROR',
              'Codex answered "turn/start" without a turn id',
            ),
          );
          return;
        }
        turn = responseTurn;
        finishIfReady();
        return;
      }

      if (message.method !== 'turn/completed' || !isRecord(message.params)) {
        return;
      }
      if (message.params.threadId !== threadId) return;

      const notificationTurn = message.params.turn;
      if (!isRecord(notificationTurn) || typeof notificationTurn.id !== 'string') {
        return;
      }
      if (turn !== undefined && notificationTurn.id !== turn.id) return;
      completions.set(notificationTurn.id, message);
      finishIfReady();
    });

    client
      .send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            {
              type: 'text',
              text: turnInstructions(executionPlan, followUpInstruction),
              text_elements: [],
            },
          ],
          cwd: sandbox.root,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['edits'],
            properties: {
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['path', 'content'],
                  properties: {
                    path: { type: 'string', minLength: 1 },
                    content: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      })
      .catch((error: unknown) => {
        settle(
          err(
            'CODEX_TRANSPORT_FAILED',
            `Could not start the Codex edit turn: ${errorMessage(error)}`,
          ),
        );
      });
  });
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

function readEdit(value: unknown): PendingEdit | undefined {
  if (!isRecord(value)) return undefined;
  const editPath = value.path ?? value.relPath;
  if (typeof editPath !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }
  return { path: editPath, content: value.content };
}

function readEdits(value: unknown): PendingEdit[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.edits)) return undefined;
  const edits = value.edits.map(readEdit);
  return edits.every((edit): edit is PendingEdit => edit !== undefined)
    ? edits
    : undefined;
}

/**
 * Extracts the edits an item declares.
 *
 * `undefined` and `[]` mean different things and must not be collapsed:
 * `undefined` means the item is not an edits message at all (commentary,
 * progress, an unrelated tool call), so it leaves any earlier edits standing.
 * `[]` means the item *is* an edits message that declares no edits, which under
 * replace semantics supersedes earlier drafts with an empty set.
 */
function editsFromItem(item: unknown): Result<PendingEdit[] | undefined> {
  if (!isRecord(item)) return ok(undefined);

  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    try {
      const parsed = parseJson(item.text);
      const edits = readEdits(parsed);
      if (edits !== undefined) return ok(edits);
      return isRecord(parsed) && Object.hasOwn(parsed, 'edits')
        ? err(
            'CODEX_EDIT_INVALID',
            'Codex agent message contained an invalid edits payload',
          )
        : ok(undefined);
    } catch {
      // Progress and commentary agent messages are allowed. A valid structured
      // final message is still required before the turn can succeed.
      return ok(undefined);
    }
  }

  if (item.type === 'dynamicToolCall') {
    const tool = typeof item.tool === 'string' ? item.tool : '';
    if (!/^(?:write_?file(?:_in_sandbox)?|apply_?edit)$/iu.test(tool)) {
      return ok(undefined);
    }
    let args: unknown = item.arguments;
    if (typeof args === 'string') {
      try {
        args = parseJson(args);
      } catch {
        return err('CODEX_EDIT_INVALID', `Codex tool call "${tool}" had invalid JSON arguments`);
      }
    }
    const many = readEdits(args);
    if (many !== undefined) return ok(many);
    const one = readEdit(args);
    return one === undefined
      ? err('CODEX_EDIT_INVALID', `Codex tool call "${tool}" did not contain a path and content`)
      : ok([one]);
  }

  return ok(undefined);
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
    if (message.params.threadId !== threadId) continue;
    if (message.params.turnId !== outcome.turn.id) continue;
    add(message.params.item);
  }

  if (Array.isArray(outcome.turn.items)) {
    for (const item of outcome.turn.items) add(item);
  }
  return items;
}

/**
 * Executes an approved plan on an existing Codex thread, then materializes the
 * returned full-file edits through the sandbox's sole authorized write path.
 *
 * Edits use REPLACE semantics, not merge semantics. An agent may emit several
 * edits messages during a turn; the last one is authoritative and supersedes
 * every earlier draft outright. Only the paths it names are written, so a path
 * that appeared in a draft but is absent from the final message is dropped
 * rather than carried forward. This mirrors what `turnInstructions` promises the
 * agent, and it lets an agent retract a draft edit simply by omitting it.
 *
 * A malformed edits message aborts the whole turn: a batch is applied in full or
 * not at all, so a partial write can never land.
 */
export async function applyEdit(
  client: AppServerHandle,
  threadId: string,
  executionPlan: ExecutionPlan,
  sandbox: SandboxHandle,
  options: ApplyEditOptions = {},
): Promise<Result<AppliedEdit>> {
  if (threadId.trim().length === 0) {
    return err('INVALID_THREAD_ID', 'Thread id must not be empty');
  }

  const outcome = await runTurn(
    client,
    threadId,
    executionPlan,
    sandbox,
    options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    options.followUpInstruction,
  );
  if (!outcome.ok) return outcome;

  const status = outcome.value.turn.status;
  if (status !== 'completed') {
    const failure = isRecord(outcome.value.turn.error)
      ? outcome.value.turn.error.message
      : undefined;
    return err(
      'CODEX_TURN_FAILED',
      typeof failure === 'string' ? failure : `Codex edit turn ended with status "${String(status)}"`,
    );
  }

  // Replace, don't merge: each edits message supersedes the previous one, so the
  // last one alone decides what gets written. Every item is still parsed, so a
  // malformed draft aborts the turn even when a later message would replace it.
  let finalEdits: PendingEdit[] | undefined;
  for (const item of completedItems(outcome.value, threadId)) {
    const parsed = editsFromItem(item);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) finalEdits = parsed.value;
  }

  // Within the winning message, a repeated path still resolves last-wins.
  const edits = new Map<string, string>(
    (finalEdits ?? []).map((edit) => [edit.path, edit.content]),
  );

  if (edits.size === 0) {
    return err('CODEX_EDIT_MISSING', 'Codex completed the turn without returning any file edits');
  }

  // Anchored to the repo the sandbox was prepared from, so the scope comes from
  // the registry rather than from anything the agent said. A plan and a sandbox
  // for different repos resolve no paths in common, which refuses every edit
  // rather than widening any: the failure direction is the safe one.
  const scope = resolvePlanScope(executionPlan, sandbox.repoId);
  if (!scope.ok) return scope;

  // Preflight, in full, before the first write: an edit batch lands whole or not
  // at all, so a path that is out of scope stops the batch rather than being
  // dropped from a set of writes that otherwise proceed. Sandbox validation runs
  // first, so a path that both escapes the sandbox and sits outside the plan is
  // reported as the escape it is.
  for (const editPath of edits.keys()) {
    const validated = await validateSandboxWrite(sandbox, editPath);
    if (!validated.ok) return validated;

    const inScope = assertEditInScope(scope.value, sandbox.root, editPath);
    if (!inScope.ok) return inScope;
  }

  const changedFiles: string[] = [];
  for (const [editPath, content] of edits) {
    const written = await writeFileInSandbox(sandbox, editPath, content);
    if (!written.ok) return written;
    changedFiles.push(editPath);
  }

  return ok({ changedFiles });
}

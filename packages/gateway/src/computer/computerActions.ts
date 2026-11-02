import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { err, ok, type Result } from '@codex-lens/shared';

import {
  controlComputer,
  type ComputerActionIntent,
  type ComputerActionResult,
  type ComputerController,
  type ComputerSurface,
} from './codexComputer.js';
import { actionConfirmationPolicy } from '../policy/actionConfirmationPolicy.js';

export interface PreparedComputerAction extends ComputerActionIntent {
  confirmationId: string;
  digest: string;
  expiresAt: string;
  requiresExplicitConfirmation: boolean;
  confirmationReason?: string;
}

export interface ExecutePreparedComputerActionRequest {
  confirmationId: string;
  digest: string;
  authorization: 'single_utterance' | 'explicit_confirmation';
}

export interface ComputerActionService {
  prepare(request: ComputerActionIntent): Promise<Result<PreparedComputerAction>>;
  execute(
    request: ExecutePreparedComputerActionRequest,
  ): Promise<Result<ComputerActionResult>>;
  cancel(confirmationId: string): Promise<Result<CancelledComputerAction>>;
}

export interface CancelledComputerAction {
  confirmationId: string;
  cancelled: boolean;
  outcomeUncertain: boolean;
  summary: string;
}

interface StoredComputerAction extends ComputerActionIntent {
  digest: string;
  expiresAt: Date;
  requiresExplicitConfirmation: boolean;
  confirmationReason?: string;
}

export interface CreateComputerActionServiceOptions {
  control?: ComputerController;
  now?: () => Date;
  id?: () => string;
  ttlMs?: number;
}

function digestFor(
  id: string,
  instruction: string,
  surface: ComputerSurface,
  expiresAt: Date,
): string {
  return createHash('sha256')
    .update(id)
    .update('\0')
    .update(instruction)
    .update('\0')
    .update(surface)
    .update('\0')
    .update(expiresAt.toISOString())
    .digest('hex');
}

function digestMatches(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createComputerActionService(
  options: CreateComputerActionServiceOptions = {},
): ComputerActionService {
  const control = options.control ?? controlComputer;
  const now = options.now ?? (() => new Date());
  const makeId = options.id ?? randomUUID;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const prepared = new Map<string, StoredComputerAction>();
  const active = new Map<string, {
    abort: AbortController;
    completion: Promise<Result<ComputerActionResult>>;
  }>();

  return {
    async prepare(request) {
      const policy = actionConfirmationPolicy(request.instruction, { scope: 'computer' });
      const confirmationId = makeId();
      const expiresAt = new Date(now().getTime() + ttlMs);
      const digest = digestFor(
        confirmationId,
        request.instruction,
        request.surface,
        expiresAt,
      );
      prepared.set(confirmationId, {
        ...request,
        digest,
        expiresAt,
        requiresExplicitConfirmation: policy.requiresExplicitConfirmation,
        ...(policy.confirmationReason === undefined
          ? {}
          : { confirmationReason: policy.confirmationReason }),
      });
      return ok({
        ...request,
        confirmationId,
        digest,
        expiresAt: expiresAt.toISOString(),
        requiresExplicitConfirmation: policy.requiresExplicitConfirmation,
        ...(policy.confirmationReason === undefined
          ? {}
          : { confirmationReason: policy.confirmationReason }),
      });
    },

    async execute(request) {
      const stored = prepared.get(request.confirmationId);
      if (stored === undefined) {
        return err(
          'COMPUTER_CONFIRMATION_NOT_FOUND',
          'That prepared computer action no longer exists. Prepare it again.',
        );
      }
      if (now() >= stored.expiresAt) {
        prepared.delete(request.confirmationId);
        return err(
          'COMPUTER_CONFIRMATION_EXPIRED',
          'That computer-action confirmation expired. Prepare it again.',
        );
      }
      if (!digestMatches(request.digest, stored.digest)) {
        return err(
          'COMPUTER_CONFIRMATION_MISMATCH',
          'The computer-action confirmation did not match. Nothing ran.',
        );
      }

      if (stored.requiresExplicitConfirmation && request.authorization !== 'explicit_confirmation') {
        return err(
          'COMPUTER_EXPLICIT_CONFIRMATION_REQUIRED',
          stored.confirmationReason
            ?? 'That computer action requires a separate explicit confirmation.',
        );
      }
      if (!stored.requiresExplicitConfirmation && request.authorization !== 'single_utterance') {
        return err(
          'COMPUTER_SINGLE_UTTERANCE_AUTHORIZATION_REQUIRED',
          'That ordinary action must use the gateway single-utterance path.',
        );
      }

      // Consume before crossing the GUI boundary. If the child times out, its
      // external effect is uncertain and must never be replayed automatically.
      prepared.delete(request.confirmationId);
      const abort = new AbortController();
      const completion = control({
        instruction: stored.instruction,
        surface: stored.surface,
        authorization: 'confirmed',
        signal: abort.signal,
      });
      active.set(request.confirmationId, { abort, completion });
      try {
        return await completion;
      } finally {
        active.delete(request.confirmationId);
      }
    },

    async cancel(confirmationId) {
      const running = active.get(confirmationId);
      if (running === undefined) {
        return err(
          'COMPUTER_ACTION_NOT_ACTIVE',
          'No in-flight computer action with that id could be verified.',
        );
      }
      running.abort.abort();
      const outcome = await running.completion;
      if (!outcome.ok && outcome.error.code === 'COMPUTER_CONTROL_CANCELLED') {
        return ok({
          confirmationId,
          cancelled: true,
          outcomeUncertain: false,
          summary: 'The in-flight computer action stopped.',
        });
      }
      if (!outcome.ok && outcome.error.code.includes('CLEANUP_UNCONFIRMED')) {
        return ok({
          confirmationId,
          cancelled: false,
          outcomeUncertain: true,
          summary: 'The computer process could not be proven stopped. Computer control is locked; inspect the Mac before restarting the gateway.',
        });
      }
      if (outcome.ok) {
        return ok({
          confirmationId,
          cancelled: false,
          outcomeUncertain: false,
          summary: 'The computer action had already finished before the stop took effect.',
        });
      }
      return ok({
        confirmationId,
        cancelled: false,
        outcomeUncertain: true,
        summary: 'The computer action ended without a verified cancellation result. Do not retry it automatically.',
      });
    },
  };
}

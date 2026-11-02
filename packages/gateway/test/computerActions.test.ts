import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '@codex-lens/shared';

import type { ComputerActionRequest } from '../src/computer/codexComputer.js';
import { createComputerActionService } from '../src/computer/computerActions.js';

const ACTION = {
  instruction: 'Open Xcode and show the current build issue.',
  surface: 'computer' as const,
};

const ORDINARY_AUTHORIZATION = 'single_utterance' as const;

function successfulControl() {
  return vi.fn(async (request: ComputerActionRequest) => ok({
    completed: true,
    confirmationRequired: false,
    summary: `Completed: ${request.instruction}`,
    surface: request.surface,
  }));
}

describe('confirmation-gated computer action service', () => {
  it('rejects a digest mismatch without consuming the valid preparation', async () => {
    const control = successfulControl();
    const service = createComputerActionService({
      control,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'computer-confirmation-1',
    });
    const prepared = await service.prepare(ACTION);
    if (!prepared.ok) throw new Error('prepare failed');

    const mismatch = await service.execute({
      confirmationId: prepared.value.confirmationId,
      digest: '0'.repeat(64),
      authorization: ORDINARY_AUTHORIZATION,
    });
    expect(mismatch).toEqual(err(
      'COMPUTER_CONFIRMATION_MISMATCH',
      'The computer-action confirmation did not match. Nothing ran.',
    ));
    expect(control).not.toHaveBeenCalled();

    const executed = await service.execute({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: ORDINARY_AUTHORIZATION,
    });
    expect(executed.ok).toBe(true);
    expect(control).toHaveBeenCalledOnce();
    expect(control).toHaveBeenCalledWith(expect.objectContaining({
      ...ACTION,
      authorization: 'confirmed',
      signal: expect.any(AbortSignal),
    }));
  });

  it('expires a preparation and never calls computer control', async () => {
    let time = new Date('2026-08-26T19:00:00.000Z');
    const control = successfulControl();
    const service = createComputerActionService({
      control,
      now: () => time,
      id: () => 'computer-confirmation-2',
      ttlMs: 1_000,
    });
    const prepared = await service.prepare(ACTION);
    if (!prepared.ok) throw new Error('prepare failed');

    time = new Date('2026-08-26T19:00:01.000Z');
    const expired = await service.execute({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: ORDINARY_AUTHORIZATION,
    });
    expect(expired).toEqual(err(
      'COMPUTER_CONFIRMATION_EXPIRED',
      'That computer-action confirmation expired. Prepare it again.',
    ));
    expect(control).not.toHaveBeenCalled();
  });

  it('consumes a successful preparation so it cannot be replayed', async () => {
    const control = successfulControl();
    const service = createComputerActionService({
      control,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'computer-confirmation-3',
    });
    const prepared = await service.prepare(ACTION);
    if (!prepared.ok) throw new Error('prepare failed');
    const request = {
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: ORDINARY_AUTHORIZATION,
    };

    const executed = await service.execute(request);
    expect(executed.ok).toBe(true);

    const replay = await service.execute(request);
    expect(replay).toEqual(err(
      'COMPUTER_CONFIRMATION_NOT_FOUND',
      'That prepared computer action no longer exists. Prepare it again.',
    ));
    expect(control).toHaveBeenCalledOnce();
  });

  it('consumes before an uncertain controller failure so failure cannot be replayed', async () => {
    const control = vi.fn(async () => err(
      'COMPUTER_CONTROL_TIMEOUT',
      'Computer control timed out; completion is uncertain.',
    ));
    const service = createComputerActionService({
      control,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'computer-confirmation-4',
    });
    const prepared = await service.prepare(ACTION);
    if (!prepared.ok) throw new Error('prepare failed');
    const request = {
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
      authorization: ORDINARY_AUTHORIZATION,
    };

    const failed = await service.execute(request);
    expect(failed).toEqual(err(
      'COMPUTER_CONTROL_TIMEOUT',
      'Computer control timed out; completion is uncertain.',
    ));

    const replay = await service.execute(request);
    expect(replay).toEqual(err(
      'COMPUTER_CONFIRMATION_NOT_FOUND',
      'That prepared computer action no longer exists. Prepare it again.',
    ));
    expect(control).toHaveBeenCalledOnce();
  });

  it('requires the authorization mode to match the gateway classification', async () => {
    const control = successfulControl();
    const service = createComputerActionService({ control, id: () => 'computer-policy-mode' });
    const safe = await service.prepare({ instruction: 'Open Xcode.', surface: 'computer' });
    if (!safe.ok) throw new Error('safe prepare failed');
    await expect(service.execute({
      confirmationId: safe.value.confirmationId,
      digest: safe.value.digest,
      authorization: 'explicit_confirmation',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMPUTER_SINGLE_UTTERANCE_AUTHORIZATION_REQUIRED' },
    });

    const consequential = await service.prepare({
      instruction: 'Delete report.pdf',
      surface: 'computer',
    });
    if (!consequential.ok) throw new Error('consequential prepare failed');
    await expect(service.execute({
      confirmationId: consequential.value.confirmationId,
      digest: consequential.value.digest,
      authorization: 'single_utterance',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMPUTER_EXPLICIT_CONFIRMATION_REQUIRED' },
    });
    expect(control).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '@codex-lens/shared';

import { openDb } from '../src/db/schema.js';
import { createSqliteMessageIntentStore } from '../src/messages/messageIntentStore.js';
import {
  createMessageService,
  resolveMacMessageDestinationWithLookup,
} from '../src/messages/messages.js';

const iMessageDestination = {
  displayName: 'Alex Example',
  handle: '+15035550123',
  serviceType: 'iMessage' as const,
  serviceAccountId: 'account-imessage-1',
};

const iMessageRequest = {
  recipient: 'Alex',
  message: 'I am on my way.',
  serviceType: 'iMessage' as const,
};

function createActiveMessageService(
  options: Parameters<typeof createMessageService>[0] = {},
) {
  const service = createMessageService(options);
  service.activate();
  return service;
}

describe('safe Messages recipient resolution', () => {
  it('rejects a short direct phone number without opening Contacts', async () => {
    const lookup = vi.fn(async () => ok(''));
    const result = await resolveMacMessageDestinationWithLookup('555-0123', lookup);

    expect(result).toEqual(err(
      'MESSAGE_RECIPIENT_INVALID',
      'Use a full phone number with 10 to 15 digits, including the area code.',
    ));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps duplicate same-name contact records separate and rejects them', async () => {
    const lookup = vi.fn(async () => ok([
      'person-1\tAlex Example\tperson\t\t',
      'person-1\tAlex Example\tphone\tmobile\t+15035550123',
      'person-2\tAlex Example\tperson\t\t',
      'person-2\tAlex Example\tphone\tmobile\t+15035550456',
    ].join('\n')));

    const result = await resolveMacMessageDestinationWithLookup('Alex Example', lookup);

    expect(result).toEqual(err(
      'MESSAGE_RECIPIENT_AMBIGUOUS',
      'Multiple contact records matched: Alex Example. Say a more specific contact name or a full phone number or email address.',
    ));
  });

  it('rejects multiple equally eligible handles on one contact record', async () => {
    const lookup = vi.fn(async () => ok([
      'person-1\tAlex Example\tperson\t\t',
      'person-1\tAlex Example\tphone\tmobile\t+15035550123',
      'person-1\tAlex Example\tphone\tiPhone\t+15035550456',
      'person-1\tAlex Example\temail\thome\talex@example.com',
    ].join('\n')));

    const result = await resolveMacMessageDestinationWithLookup('Alex Example', lookup);

    expect(result).toEqual(err(
      'MESSAGE_DESTINATION_AMBIGUOUS',
      'Alex Example has multiple equally eligible Messages destinations. Say the full phone number or email address.',
    ));
  });

  it('deduplicates one repeated handle and prefers it over lower-ranked handles', async () => {
    const lookup = vi.fn(async () => ok([
      'person-1\tAlex Example\tperson\t\t',
      'person-1\tAlex Example\tphone\tmobile\t(503) 555-0123',
      'person-1\tAlex Example\tphone\tiPhone\t503-555-0123',
      'person-1\tAlex Example\tphone\thome\t503-555-0456',
      'person-1\tAlex Example\temail\thome\talex@example.com',
    ].join('\n')));

    const result = await resolveMacMessageDestinationWithLookup('Alex Example', lookup);

    expect(result).toEqual(ok({ displayName: 'Alex Example', handle: '5035550123' }));
  });
});

describe('confirmation-gated Messages service', () => {
  it('binds one send to the exact prepared recipient and body', async () => {
    const send = vi.fn(async () => ok(undefined));
    const service = createActiveMessageService({
      resolve: async () => ok(iMessageDestination),
      send,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'confirmation-1',
    });

    const prepared = await service.prepare(iMessageRequest);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value).toMatchObject({
      confirmationId: 'confirmation-1',
      recipientDisplay: 'Alex Example',
      maskedDestination: '••••0123',
      message: 'I am on my way.',
      serviceType: 'iMessage',
      requiresExplicitConfirmation: true,
    });

    const mismatch = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: '0'.repeat(64),
    });
    expect(mismatch).toEqual(err(
      'MESSAGE_CONFIRMATION_MISMATCH',
      'The message confirmation did not match. Nothing was sent.',
    ));
    expect(send).not.toHaveBeenCalled();

    // A mismatch does not consume the valid preparation.
    const sent = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(sent.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      iMessageDestination,
      'I am on my way.',
    );

    const replay = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(replay.ok).toBe(false);
  });

  it('expires preparations and never calls Messages', async () => {
    let time = new Date('2026-08-26T19:00:00.000Z');
    const send = vi.fn(async () => ok(undefined));
    const service = createActiveMessageService({
      resolve: async () => ok({
        ...iMessageDestination,
        displayName: 'Alex',
        handle: 'alex@example.com',
      }),
      send,
      now: () => time,
      id: () => 'confirmation-2',
      ttlMs: 1_000,
    });
    const prepared = await service.prepare({
      recipient: 'Alex',
      message: 'Test',
      serviceType: 'iMessage',
    });
    if (!prepared.ok) throw new Error('prepare failed');
    time = new Date('2026-08-26T19:00:02.000Z');
    const result = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('consumes before an uncertain external failure and never retries it', async () => {
    const send = vi.fn(async () => err(
      'MESSAGES_AUTOMATION_TIMEOUT',
      'Mac Messages automation timed out.',
    ));
    const service = createActiveMessageService({
      resolve: async () => ok({ ...iMessageDestination, displayName: 'Alex' }),
      send,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'confirmation-3',
    });
    const prepared = await service.prepare({
      recipient: 'Alex',
      message: 'Test',
      serviceType: 'iMessage',
    });
    if (!prepared.ok) throw new Error('prepare failed');

    const first = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(first.ok).toBe(false);
    expect(send).toHaveBeenCalledOnce();

    const retry = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(retry).toEqual(err(
      'MESSAGE_SEND_OUTCOME_UNCERTAIN',
      'The prior send outcome is uncertain. It will not be retried because that could duplicate the text.',
    ));
    expect(send).toHaveBeenCalledOnce();
  });

  it('allows only one sender to consume a confirmation under concurrent replay', async () => {
    const send = vi.fn(async () => ok(undefined));
    const service = createActiveMessageService({
      resolve: async () => ok({ ...iMessageDestination, displayName: 'Alex' }),
      send,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'confirmation-concurrent',
    });
    const prepared = await service.prepare({
      recipient: 'Alex',
      message: 'Test',
      serviceType: 'iMessage',
    });
    if (!prepared.ok) throw new Error('prepare failed');

    const request = {
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    };
    const [first, replay] = await Promise.all([
      service.send(request),
      service.send(request),
    ]);

    expect([first.ok, replay.ok].filter(Boolean)).toHaveLength(1);
    expect([first, replay]).toContainEqual(err(
      'MESSAGE_SEND_ALREADY_STARTED',
      'That message send already started. Its outcome may still be pending; it will not be retried.',
    ));
    expect(send).toHaveBeenCalledOnce();
  });

  it('binds the requested service into the preview, digest, and sender call', async () => {
    const send = vi.fn(async () => ok(undefined));
    const service = createActiveMessageService({
      resolve: async (_recipient, serviceType) => ok({
        displayName: 'Alex',
        handle: '+15035550123',
        serviceType,
        serviceAccountId: `account-${serviceType}`,
      }),
      send,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'confirmation-service',
    });

    const prepared = await service.prepare({
      recipient: 'Alex',
      message: 'Use RCS.',
      serviceType: 'RCS',
    });
    if (!prepared.ok) throw new Error('prepare failed');
    expect(prepared.value.serviceType).toBe('RCS');

    const sent = await service.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(sent).toMatchObject({ ok: true, value: { serviceType: 'RCS' } });
    expect(send).toHaveBeenCalledWith({
      displayName: 'Alex',
      handle: '+15035550123',
      serviceType: 'RCS',
      serviceAccountId: 'account-RCS',
    }, 'Use RCS.');
  });

  it('rejects a resolver that returns a different service than requested', async () => {
    const send = vi.fn(async () => ok(undefined));
    const service = createActiveMessageService({
      resolve: async () => ok(iMessageDestination),
      send,
    });

    const result = await service.prepare({
      recipient: 'Alex',
      message: 'Do not route this through iMessage.',
      serviceType: 'SMS',
    });

    expect(result).toEqual(err(
      'MESSAGES_SERVICE_MISMATCH',
      'The resolved Messages service did not match the requested service. Nothing was prepared.',
    ));
    expect(send).not.toHaveBeenCalled();
  });

  it('persists accepted state without persisting a replayable message body', async () => {
    const db = openDb(':memory:');
    const send = vi.fn(async () => ok(undefined));
    const now = () => new Date('2026-08-26T19:00:00.000Z');
    const firstProcess = createActiveMessageService({
      db,
      resolve: async () => ok(iMessageDestination),
      send,
      now,
      id: () => 'confirmation-durable-accepted',
    });
    const prepared = await firstProcess.prepare(iMessageRequest);
    if (!prepared.ok) throw new Error('prepare failed');
    await firstProcess.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });

    const restartedProcess = createActiveMessageService({ db, now });
    const status = await restartedProcess.status(prepared.value.confirmationId);
    expect(status).toMatchObject({
      ok: true,
      value: {
        state: 'accepted',
        serviceType: 'iMessage',
        acceptedAt: '2026-08-26T19:00:00.000Z',
      },
    });
    const replay = await restartedProcess.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(replay).toEqual(err(
      'MESSAGE_ALREADY_ACCEPTED',
      'Messages already accepted that text. It will not be sent again.',
    ));
    db.close();
  });

  it('marks a persisted in-flight send uncertain only after listener activation', async () => {
    const db = openDb(':memory:');
    const store = createSqliteMessageIntentStore(db);
    store.insert({
      confirmationId: 'confirmation-interrupted-send',
      digest: 'b'.repeat(64),
      recipientDisplay: 'Alex Example',
      maskedDestination: '••••0123',
      serviceType: 'iMessage',
      state: 'sending',
      preparedAt: '2026-08-26T18:59:00.000Z',
      expiresAt: '2026-08-26T19:04:00.000Z',
      updatedAt: '2026-08-26T19:00:00.000Z',
    });
    const send = vi.fn(async () => ok(undefined));
    const restartedProcess = createMessageService({
      intentStore: store,
      send,
      now: () => new Date('2026-08-26T19:01:00.000Z'),
    });

    await expect(restartedProcess.status('confirmation-interrupted-send')).resolves.toEqual(err(
      'MESSAGES_SERVICE_NOT_ACTIVE',
      'The Messages service is not active on the gateway listener.',
    ));
    expect(store.get('confirmation-interrupted-send')).toMatchObject({ state: 'sending' });

    restartedProcess.activate();
    await expect(restartedProcess.status('confirmation-interrupted-send')).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'uncertain',
        updatedAt: '2026-08-26T19:01:00.000Z',
        failureCode: 'GATEWAY_RESTART_MESSAGE_OUTCOME_UNCERTAIN',
      },
    });
    await expect(restartedProcess.send({
      confirmationId: 'confirmation-interrupted-send',
      digest: 'b'.repeat(64),
    })).resolves.toEqual(err(
      'MESSAGE_SEND_OUTCOME_UNCERTAIN',
      'The prior send outcome is uncertain. It will not be retried because that could duplicate the text.',
    ));
    expect(send).not.toHaveBeenCalled();

    restartedProcess.activate();
    expect(store.get('confirmation-interrupted-send')).toMatchObject({
      state: 'uncertain',
      updatedAt: '2026-08-26T19:01:00.000Z',
    });
    db.close();
  });

  it('fails closed across a restart before an unconsumed preparation can send', async () => {
    const db = openDb(':memory:');
    const send = vi.fn(async () => ok(undefined));
    const options = {
      db,
      resolve: async () => ok(iMessageDestination),
      send,
      now: () => new Date('2026-08-26T19:00:00.000Z'),
      id: () => 'confirmation-restart',
    };
    const firstProcess = createActiveMessageService(options);
    const prepared = await firstProcess.prepare(iMessageRequest);
    if (!prepared.ok) throw new Error('prepare failed');

    const restartedProcess = createMessageService(options);
    await expect(restartedProcess.status(prepared.value.confirmationId)).resolves.toEqual(err(
      'MESSAGES_SERVICE_NOT_ACTIVE',
      'The Messages service is not active on the gateway listener.',
    ));
    restartedProcess.activate();
    const result = await restartedProcess.send({
      confirmationId: prepared.value.confirmationId,
      digest: prepared.value.digest,
    });
    expect(result).toEqual(err(
      'MESSAGE_CONFIRMATION_RESTARTED',
      'The gateway restarted after preparing that message. It was not sent; prepare it again.',
    ));
    expect(send).not.toHaveBeenCalled();
    const status = await restartedProcess.status(prepared.value.confirmationId);
    expect(status).toMatchObject({
      ok: true,
      value: {
        state: 'rejected',
        failureCode: 'MESSAGE_CONFIRMATION_RESTARTED',
      },
    });
    db.close();
  });
});

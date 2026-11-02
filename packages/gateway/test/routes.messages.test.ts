import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { err, ok, type Result } from '@codex-lens/shared';

import { GATEWAY_TOKEN_ENV } from '../src/auth/index.js';
import { openDb } from '../src/db/schema.js';
import { waitForOwnedListenerActivations } from '../src/lifecycle/listenerActivation.js';
import {
  createMessageService,
  type MessageService,
} from '../src/messages/messages.js';
import { buildServer } from '../src/server.js';

const TOKEN = 'messages-route-test-token';
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env[GATEWAY_TOKEN_ENV];
  process.env[GATEWAY_TOKEN_ENV] = TOKEN;
});

afterEach(() => {
  if (originalToken === undefined) delete process.env[GATEWAY_TOKEN_ENV];
  else process.env[GATEWAY_TOKEN_ENV] = originalToken;
});

function fakeService(): MessageService {
  return {
    activate: vi.fn(),
    prepare: vi.fn(async (request) => ok({
      confirmationId: 'confirm-1',
      digest: 'a'.repeat(64),
      recipientDisplay: request.recipient,
      maskedDestination: '••••0123',
      message: request.message,
      serviceType: request.serviceType,
      expiresAt: '2026-08-26T19:05:00.000Z',
      requiresExplicitConfirmation: true as const,
    })),
    send: vi.fn(async () => ok({
      sent: true as const,
      recipientDisplay: 'Alex Example',
      serviceType: 'iMessage' as const,
      sentAt: '2026-08-26T19:01:00.000Z',
    })),
    status: vi.fn(async (confirmationId) => ok({
      confirmationId,
      recipientDisplay: 'Alex Example',
      maskedDestination: '••••0123',
      serviceType: 'iMessage' as const,
      state: 'prepared' as const,
      preparedAt: '2026-08-26T19:00:00.000Z',
      expiresAt: '2026-08-26T19:05:00.000Z',
      updatedAt: '2026-08-26T19:00:00.000Z',
    })),
    readiness: vi.fn(async () => ok({
      contactsAccessible: true,
      services: [
        { serviceType: 'iMessage' as const, available: true, accountCount: 1 },
        { serviceType: 'SMS' as const, available: true, accountCount: 1 },
        { serviceType: 'RCS' as const, available: false, accountCount: 0 },
      ],
      ready: true,
    })),
  };
}

describe('Messages routes', () => {
  it('closes the listener when durable message recovery fails', async () => {
    const messages = fakeService();
    messages.activate = vi.fn(() => { throw new Error('recovery failed'); });
    const server = buildServer({ messageService: messages });

    await server.listen({ host: '127.0.0.1', port: 0 });
    await expect(waitForOwnedListenerActivations(server)).rejects.toThrow('recovery failed');
    await vi.waitFor(() => expect(server.server.listening).toBe(false));
    expect(messages.activate).toHaveBeenCalledOnce();
    await server.close();
  });

  it('does not rewrite a live in-flight send when a duplicate gateway loses its bind', async () => {
    const db = openDb(':memory:');
    let finishSend!: (result: Result<void>) => void;
    const externalSend = new Promise<Result<void>>((resolve) => { finishSend = resolve; });
    const send = vi.fn(async () => externalSend);
    const destination = {
      displayName: 'Alex Example',
      handle: '+15035550123',
      serviceType: 'iMessage' as const,
      serviceAccountId: 'account-imessage-1',
    };
    const firstService = createMessageService({
      db,
      resolve: async () => ok(destination),
      send,
      id: () => 'confirmation-listener-owner',
      now: () => new Date('2026-08-26T19:00:00.000Z'),
    });
    const firstServer = buildServer({ db, messageService: firstService });
    const duplicateService = createMessageService({
      db,
      resolve: async () => ok(destination),
      send: vi.fn(async () => ok(undefined)),
      now: () => new Date('2026-08-26T19:01:00.000Z'),
    });
    const duplicateServer = buildServer({ db, messageService: duplicateService });

    try {
      await firstServer.listen({ host: '127.0.0.1', port: 0 });
      const prepared = await firstService.prepare({
        recipient: 'Alex Example',
        message: 'Test only.',
        serviceType: 'iMessage',
      });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const sendAttempt = firstService.send({
        confirmationId: prepared.value.confirmationId,
        digest: prepared.value.digest,
      });
      await vi.waitFor(async () => {
        await expect(firstService.status(prepared.value.confirmationId)).resolves.toMatchObject({
          ok: true,
          value: { state: 'sending' },
        });
      });

      const address = firstServer.server.address();
      if (address === null || typeof address === 'string') throw new Error('missing TCP listener');
      await expect(duplicateServer.listen({
        host: '127.0.0.1',
        port: address.port,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });

      await expect(firstService.status(prepared.value.confirmationId)).resolves.toMatchObject({
        ok: true,
        value: { state: 'sending' },
      });
      await expect(duplicateService.status(prepared.value.confirmationId)).resolves.toMatchObject({
        ok: false,
        error: { code: 'MESSAGES_SERVICE_NOT_ACTIVE' },
      });

      finishSend(ok(undefined));
      await expect(sendAttempt).resolves.toMatchObject({ ok: true });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      finishSend?.(ok(undefined));
      await Promise.allSettled([firstServer.close(), duplicateServer.close()]);
      db.close();
    }
  });

  it('authenticates and returns a non-sending preparation', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/messages/prepare',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        recipient: 'Alex Example',
        message: 'I am on my way.',
        serviceType: 'iMessage',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      confirmationId: 'confirm-1',
      recipientDisplay: 'Alex Example',
      serviceType: 'iMessage',
      requiresExplicitConfirmation: true,
    });
    expect(messages.send).not.toHaveBeenCalled();
    await server.close();
  });

  it('rejects malformed input and maps ambiguous recipients', async () => {
    const messages = fakeService();
    messages.prepare = vi.fn(async () => err(
      'MESSAGE_RECIPIENT_AMBIGUOUS',
      'Multiple contacts matched. Say the full contact name.',
    ));
    const server = buildServer({ messageService: messages });
    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/messages/prepare',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        recipient: 'Alex',
        message: 'Hello',
        serviceType: 'iMessage',
        sendNow: true,
      },
    });
    expect(invalid.statusCode).toBe(400);

    const ambiguous = await server.inject({
      method: 'POST',
      url: '/v1/messages/prepare',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { recipient: 'Alex', message: 'Hello', serviceType: 'iMessage' },
    });
    expect(ambiguous.statusCode).toBe(422);
    expect(ambiguous.json()).toMatchObject({
      message: 'Multiple contacts matched. Say the full contact name.',
    });
    await server.close();
  });

  it('sends only through the separate confirmation endpoint', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/messages/send',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { confirmationId: 'confirm-1', digest: 'a'.repeat(64) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sent: true,
      recipientDisplay: 'Alex Example',
      serviceType: 'iMessage',
      sentAt: '2026-08-26T19:01:00.000Z',
    });
    expect(messages.send).toHaveBeenCalledOnce();
    await server.close();
  });

  it('blocks unauthenticated sends before the Messages service is called', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/messages/send',
      payload: { confirmationId: 'confirm-1', digest: 'a'.repeat(64) },
    });

    expect(response.statusCode).toBe(401);
    expect(messages.send).not.toHaveBeenCalled();
    await server.close();
  });

  it('rejects attempts to alter the recipient or body at send time', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/messages/send',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        confirmationId: 'confirm-1',
        digest: 'a'.repeat(64),
        recipient: 'Different Recipient',
        message: 'Different body',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(messages.send).not.toHaveBeenCalled();
    await server.close();
  });

  it('requires an explicit Messages service at preparation time', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/messages/prepare',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { recipient: 'Alex', message: 'Hello' },
    });

    expect(response.statusCode).toBe(400);
    expect(messages.prepare).not.toHaveBeenCalled();
    await server.close();
  });

  it('returns authenticated readiness without sending or resolving a recipient', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/messages/readiness',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contactsAccessible: true,
      services: [
        { serviceType: 'iMessage', available: true, accountCount: 1 },
        { serviceType: 'SMS', available: true, accountCount: 1 },
        { serviceType: 'RCS', available: false, accountCount: 0 },
      ],
      ready: true,
    });
    expect(messages.send).not.toHaveBeenCalled();
    expect(messages.prepare).not.toHaveBeenCalled();
    await server.close();
  });

  it('returns a redacted durable message intent status', async () => {
    const messages = fakeService();
    const server = buildServer({ messageService: messages });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/messages/confirm-1/status',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      confirmationId: 'confirm-1',
      recipientDisplay: 'Alex Example',
      maskedDestination: '••••0123',
      serviceType: 'iMessage',
      state: 'prepared',
      preparedAt: '2026-08-26T19:00:00.000Z',
      expiresAt: '2026-08-26T19:05:00.000Z',
      updatedAt: '2026-08-26T19:00:00.000Z',
    });
    expect(messages.status).toHaveBeenCalledWith('confirm-1');
    await server.close();
  });
});

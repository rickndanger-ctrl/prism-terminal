import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createMessageService,
  MESSAGE_SERVICE_TYPES,
  type MessageService,
} from '../messages/messages.js';
import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';
import { registerOwnedListenerActivation } from '../lifecycle/listenerActivation.js';

export const MESSAGE_PREPARE_PATH = '/v1/messages/prepare';
export const MESSAGE_SEND_PATH = '/v1/messages/send';
export const MESSAGE_READINESS_PATH = '/v1/messages/readiness';
export const MESSAGE_STATUS_PATH = '/v1/messages/:confirmationId/status';

const SafeText = z.string().trim().min(1).refine((value) => !value.includes('\0'));

export const PrepareTextMessageRequestSchema = z.object({
  recipient: SafeText.max(120),
  message: SafeText.max(1_600),
  serviceType: z.enum(MESSAGE_SERVICE_TYPES),
}).strict();

export const PreparedTextMessageResponseSchema = z.object({
  confirmationId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  recipientDisplay: z.string().min(1),
  maskedDestination: z.string().min(1),
  message: z.string().min(1),
  serviceType: z.enum(MESSAGE_SERVICE_TYPES),
  expiresAt: z.iso.datetime(),
  requiresExplicitConfirmation: z.literal(true),
}).strict();

export const SendPreparedTextRequestSchema = z.object({
  confirmationId: z.string().trim().min(1).max(120),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const SentTextMessageResponseSchema = z.object({
  sent: z.literal(true),
  recipientDisplay: z.string().min(1),
  serviceType: z.enum(MESSAGE_SERVICE_TYPES),
  sentAt: z.iso.datetime(),
}).strict();

const MessageIntentStatusSchema = z.object({
  confirmationId: z.string().min(1),
  recipientDisplay: z.string().min(1),
  maskedDestination: z.string().min(1),
  serviceType: z.enum(MESSAGE_SERVICE_TYPES),
  state: z.enum(['prepared', 'sending', 'accepted', 'uncertain', 'expired', 'rejected']),
  preparedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().optional(),
  failureCode: z.string().min(1).optional(),
}).strict();

const MessageReadinessSchema = z.object({
  contactsAccessible: z.boolean(),
  services: z.array(z.object({
    serviceType: z.enum(MESSAGE_SERVICE_TYPES),
    available: z.boolean(),
    accountCount: z.number().int().nonnegative(),
  }).strict()).length(MESSAGE_SERVICE_TYPES.length),
  ready: z.boolean(),
}).strict();

const MessageStatusParamsSchema = z.object({
  confirmationId: z.string().trim().min(1).max(120),
}).strict();

const MessageActionErrorSchema = z.object({
  statusCode: z.union([z.literal(422), z.literal(503)]),
  error: z.union([z.literal('Unprocessable Entity'), z.literal('Service Unavailable')]),
  message: z.string().min(1),
}).strict();

const MessageNotFoundErrorSchema = z.object({
  statusCode: z.literal(404),
  error: z.literal('Not Found'),
  message: z.string().min(1),
}).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

function isUnavailable(code: string): boolean {
  return code.startsWith('MESSAGES_AUTOMATION_') ||
    code.startsWith('MESSAGES_SEND_') ||
    code.startsWith('MESSAGES_SERVICE_');
}

export function registerMessageRoutes(
  server: FastifyInstance,
  messages: MessageService = createMessageService(),
): void {
  registerOwnedListenerActivation(
    server,
    'message intent recovery',
    () => messages.activate(),
  );

  server.get(MESSAGE_READINESS_PATH, {
    schema: {
      response: {
        200: jsonSchema(MessageReadinessSchema),
        503: jsonSchema(MessageActionErrorSchema),
      },
    },
  }, async (request, reply) => {
    const result = await messages.readiness();
    if (!result.ok) {
      request.log.warn({ code: result.error.code }, 'message readiness inspection failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: result.error.message,
      });
    }
    return result.value;
  });

  server.get(MESSAGE_STATUS_PATH, {
    schema: {
      params: jsonSchema(MessageStatusParamsSchema),
      response: {
        200: jsonSchema(MessageIntentStatusSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(MessageNotFoundErrorSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(
      MessageStatusParamsSchema,
      request.params,
      'INVALID_MESSAGE_STATUS_REQUEST',
    );
    if (!params.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: params.error.message,
      });
    }
    const result = await messages.status(params.value.confirmationId);
    if (!result.ok) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: result.error.message,
      });
    }
    return result.value;
  });

  server.post(MESSAGE_PREPARE_PATH, {
    schema: {
      body: jsonSchema(PrepareTextMessageRequestSchema),
      response: {
        200: jsonSchema(PreparedTextMessageResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        422: jsonSchema(MessageActionErrorSchema),
        503: jsonSchema(MessageActionErrorSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      PrepareTextMessageRequestSchema,
      request.body,
      'INVALID_MESSAGE_PREPARE_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    const result = await messages.prepare(body.value);
    if (!result.ok) {
      const unavailable = isUnavailable(result.error.code);
      request.log.warn({ code: result.error.code }, 'message preparation failed');
      return reply.code(unavailable ? 503 : 422).send({
        statusCode: unavailable ? 503 : 422,
        error: unavailable ? 'Service Unavailable' : 'Unprocessable Entity',
        message: result.error.message,
      });
    }
    return result.value;
  });

  server.post(MESSAGE_SEND_PATH, {
    schema: {
      body: jsonSchema(SendPreparedTextRequestSchema),
      response: {
        200: jsonSchema(SentTextMessageResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        422: jsonSchema(MessageActionErrorSchema),
        503: jsonSchema(MessageActionErrorSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      SendPreparedTextRequestSchema,
      request.body,
      'INVALID_MESSAGE_SEND_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    const result = await messages.send(body.value);
    if (!result.ok) {
      const unavailable = isUnavailable(result.error.code);
      request.log.warn({ code: result.error.code }, 'message send failed');
      return reply.code(unavailable ? 503 : 422).send({
        statusCode: unavailable ? 503 : 422,
        error: unavailable ? 'Service Unavailable' : 'Unprocessable Entity',
        message: result.error.message,
      });
    }
    return result.value;
  });
}

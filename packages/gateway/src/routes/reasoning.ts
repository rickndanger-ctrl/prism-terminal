import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';
import {
  ReasoningAnswerSchema,
  type ReasoningAnswerer,
} from '../reasoning/answer.js';

export const REASONING_ANSWER_PATH = '/v1/reasoning/answer';

export const ReasoningAnswerRequestSchema = z.object({
  question: z.string().trim().min(2).max(1_000),
}).strict();

const ReasoningUnavailableSchema = z.object({
  statusCode: z.literal(503),
  error: z.literal('Service Unavailable'),
  message: z.literal('Reasoning is temporarily unavailable.'),
}).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

export function registerReasoningRoutes(
  server: FastifyInstance,
  answerer?: ReasoningAnswerer,
): void {
  server.post(REASONING_ANSWER_PATH, {
    schema: {
      body: jsonSchema(ReasoningAnswerRequestSchema),
      response: {
        200: jsonSchema(ReasoningAnswerSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        503: jsonSchema(ReasoningUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      ReasoningAnswerRequestSchema,
      request.body,
      'INVALID_REASONING_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }

    if (answerer === undefined) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Reasoning is temporarily unavailable.',
      });
    }

    const result = await answerer(body.value.question);
    if (!result.ok) {
      // Only the stable code is logged. Upstream details and the private
      // question never enter gateway logs or the HTTP response.
      request.log.warn({ code: result.error.code }, 'reasoning failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Reasoning is temporarily unavailable.',
      });
    }

    const response = validateBoundary(
      ReasoningAnswerSchema,
      result.value,
      'INVALID_REASONING_RESPONSE',
    );
    if (!response.ok) {
      request.log.error({ code: response.error.code }, 'reasoning returned invalid data');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Reasoning is temporarily unavailable.',
      });
    }

    return response.value;
  });
}

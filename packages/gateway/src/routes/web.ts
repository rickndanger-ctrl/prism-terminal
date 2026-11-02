import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';
import {
  WebResearchResultSchema,
  type WebResearcher,
} from '../web/research.js';

export const WEB_RESEARCH_PATH = '/v1/web/research';

export const WebResearchRequestSchema = z.object({
  question: z.string().trim().min(2).max(1_000),
}).strict();

const WebResearchUnavailableSchema = z.object({
  statusCode: z.literal(503),
  error: z.literal('Service Unavailable'),
  message: z.string().min(1),
}).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

export function registerWebRoutes(
  server: FastifyInstance,
  researcher?: WebResearcher,
): void {
  server.post(WEB_RESEARCH_PATH, {
    schema: {
      body: jsonSchema(WebResearchRequestSchema),
      response: {
        200: jsonSchema(WebResearchResultSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        503: jsonSchema(WebResearchUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      WebResearchRequestSchema,
      request.body,
      'INVALID_WEB_RESEARCH_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    if (researcher === undefined) {
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Live web research is not configured.',
      });
    }

    const result = await researcher(body.value.question);
    if (!result.ok) {
      request.log.warn({ code: result.error.code }, 'web research failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: result.error.message,
      });
    }
    return result.value;
  });
}

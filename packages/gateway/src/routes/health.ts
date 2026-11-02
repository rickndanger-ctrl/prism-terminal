import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HEALTH_PATH } from '../auth/index.js';
import {
  BoundaryBadRequestSchema,
  validateBoundary,
} from '../http/validation.js';

export const HealthRequestSchema = z.object({}).strict();

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    version: z.string().trim().min(1),
  })
  .strict();

export type HealthResponse = z.output<typeof HealthResponseSchema>;

export function registerHealthRoute(
  server: FastifyInstance,
  version: string,
): void {
  server.get(
    HEALTH_PATH,
    {
      schema: {
        querystring: z.toJSONSchema(HealthRequestSchema, { target: 'draft-7' }),
        response: {
          200: z.toJSONSchema(HealthResponseSchema, { target: 'draft-7' }),
          400: z.toJSONSchema(BoundaryBadRequestSchema, { target: 'draft-7' }),
        },
      },
    },
    async (request, reply) => {
      const validatedRequest = validateBoundary(
        HealthRequestSchema,
        request.query,
        'INVALID_HEALTH_REQUEST',
      );
      if (!validatedRequest.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: validatedRequest.error.message,
        });
      }

      const response = validateBoundary(
        HealthResponseSchema,
        { status: 'ok', version },
        'INVALID_HEALTH_RESPONSE',
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      return response.value;
    },
  );
}

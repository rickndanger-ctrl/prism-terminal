import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/schema.js';
import {
  BoundaryBadRequestSchema,
  validateBoundary,
} from '../http/validation.js';
import { RegistryRecordSchema } from '../registry/projectRegistry.js';
import { loadRegistry } from '../registry/registry.js';

export const PROJECTS_PATH = '/v1/projects';

export const ProjectsRequestSchema = z.object({}).strict();

export const ProjectsResponseSchema = z
  .object({
    projects: z.array(RegistryRecordSchema).readonly(),
  })
  .strict()
  .readonly();

export type ProjectsResponse = z.output<typeof ProjectsResponseSchema>;

export function registerProjectsRoute(server: FastifyInstance, db: Db): void {
  server.get(
    PROJECTS_PATH,
    {
      schema: {
        querystring: z.toJSONSchema(ProjectsRequestSchema, { target: 'draft-7' }),
        response: {
          200: z.toJSONSchema(ProjectsResponseSchema, { target: 'draft-7' }),
          400: z.toJSONSchema(BoundaryBadRequestSchema, { target: 'draft-7' }),
        },
      },
    },
    async (request, reply) => {
      const validatedRequest = validateBoundary(
        ProjectsRequestSchema,
        request.query,
        'INVALID_PROJECTS_REQUEST',
      );
      if (!validatedRequest.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: validatedRequest.error.message,
        });
      }

      const registry = loadRegistry(db);
      if (!registry.ok) {
        throw new Error(registry.error.message);
      }

      const response = validateBoundary(
        ProjectsResponseSchema,
        { projects: registry.value },
        'INVALID_PROJECTS_RESPONSE',
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      return response.value;
    },
  );
}

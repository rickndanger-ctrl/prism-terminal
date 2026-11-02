import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/schema.js';
import { inspectCodexProject, type CodexProjectInspection } from '../codex/inspectProject.js';
import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';
import { getProjectById } from '../registry/registry.js';
import type { RegistryRecord } from '../registry/projectRegistry.js';

export const CODEX_INSPECT_PATH = '/v1/codex/inspect';

const InspectRequestSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(20_000),
}).strict();

const InspectResponseSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  summary: z.string().min(1),
  files: z.array(z.string().min(1)).max(20),
  readOnly: z.literal(true),
}).strict();

const NotFoundSchema = z.object({
  statusCode: z.literal(404),
  error: z.literal('Not Found'),
  message: z.string().min(1),
}).strict();

const UnavailableSchema = z.object({
  statusCode: z.literal(503),
  error: z.literal('Service Unavailable'),
  message: z.string().min(1),
}).strict();

export type CodexProjectInspector = (
  project: RegistryRecord,
  question: string,
) => Promise<{ ok: true; value: CodexProjectInspection } | { ok: false; error: { code: string; message: string } }>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

export function registerCodexRoutes(
  server: FastifyInstance,
  db: Db,
  inspector: CodexProjectInspector = inspectCodexProject,
): void {
  server.post(CODEX_INSPECT_PATH, {
    schema: {
      body: jsonSchema(InspectRequestSchema),
      response: {
        200: jsonSchema(InspectResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        503: jsonSchema(UnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(InspectRequestSchema, request.body, 'INVALID_CODEX_INSPECTION');
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    const project = getProjectById(db, body.value.projectId);
    if (!project.ok) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: project.error.message,
      });
    }
    const inspected = await inspector(project.value, body.value.question);
    if (!inspected.ok) {
      request.log.warn({ code: inspected.error.code }, 'Codex project inspection failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: inspected.error.message,
      });
    }
    return inspected.value;
  });
}

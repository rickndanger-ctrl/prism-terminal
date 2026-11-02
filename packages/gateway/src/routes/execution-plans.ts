import {
  ApprovalStatus,
  EngineeringPlanStatus,
  canApproveEngineeringPlan,
  executionPlanSchema,
} from '@codex-lens/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/schema.js';
import { getEngineeringPlan } from '../engineering-plan-store.js';
import {
  getPreparedExecutionPlan,
  savePreparedExecutionPlan,
  type PreparedExecutionPlan,
} from '../execution-plan-store.js';
import { validateBoundary, BoundaryBadRequestSchema } from '../http/validation.js';
import { generateExecutionPlan } from '../plan-generation.js';
import { getProjectById } from '../registry/registry.js';

export const EXECUTION_PLANS_PATH = '/v1/execution-plans';
const nonEmpty = z.string().trim().min(1);

export const PrepareExecutionPlanRequestSchema = z.object({
  projectId: nonEmpty,
  idempotencyKey: nonEmpty,
  request: z.object({
    text: nonEmpty.max(20_000),
    engineeringPlanId: nonEmpty,
    engineeringPlanVersion: z.number().int().positive(),
    engineeringPlanDigest: z.string().regex(/^[0-9a-f]{64}$/),
    filesToModify: z.array(nonEmpty).max(100).optional(),
    filesToCreate: z.array(nonEmpty).max(100).optional(),
    filesToDelete: z.array(nonEmpty).max(100).optional(),
  }).strict(),
}).strict();

export const PreparedExecutionPlanResponseSchema = z.object({
  projectId: nonEmpty,
  plan: executionPlanSchema,
  createdAt: z.iso.datetime({ offset: true }),
}).strict().readonly();

const ParamsSchema = z.object({ executionPlanId: nonEmpty }).strict();
const NotFoundSchema = z.object({
  statusCode: z.literal(404),
  error: z.literal('Not Found'),
  message: nonEmpty,
}).strict();
const UnprocessableSchema = z.object({
  statusCode: z.literal(422),
  error: z.literal('Unprocessable Entity'),
  message: nonEmpty,
}).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

function response(prepared: PreparedExecutionPlan) {
  return { projectId: prepared.projectId, plan: prepared.plan, createdAt: prepared.createdAt };
}

export function registerExecutionPlanRoutes(server: FastifyInstance, db: Db): void {
  server.post(EXECUTION_PLANS_PATH, {
    schema: {
      body: jsonSchema(PrepareExecutionPlanRequestSchema),
      response: {
        200: jsonSchema(PreparedExecutionPlanResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        422: jsonSchema(UnprocessableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      PrepareExecutionPlanRequestSchema,
      request.body,
      'INVALID_PREPARE_EXECUTION_PLAN_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: body.error.message });
    }

    const project = getProjectById(db, body.value.projectId);
    if (!project.ok) {
      return reply.code(project.error.code === 'PROJECT_NOT_FOUND' ? 404 : 400).send({
        statusCode: project.error.code === 'PROJECT_NOT_FOUND' ? 404 : 400,
        error: project.error.code === 'PROJECT_NOT_FOUND' ? 'Not Found' : 'Bad Request',
        message: project.error.message,
      });
    }
    if (!project.value.allowWorkspaceWrite) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: 'Project policy does not allow workspace writes' });
    }

    const engineering = getEngineeringPlan(db, body.value.request.engineeringPlanId);
    if (!engineering.ok) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: engineering.error.message });
    }
    if (engineering.value.projectId !== project.value.id) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: 'Engineering plan belongs to a different project' });
    }
    if (
      engineering.value.plan.version !== body.value.request.engineeringPlanVersion ||
      engineering.value.plan.contentDigest !== body.value.request.engineeringPlanDigest
    ) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: 'Engineering plan version or digest does not match the approved plan' });
    }
    if (
      engineering.value.plan.status !== EngineeringPlanStatus.Approved ||
      engineering.value.approval?.approvalStatus !== ApprovalStatus.Approved
    ) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: 'Engineering plan requires exact approval before an Execution Plan can be created' });
    }
    const binding = canApproveEngineeringPlan(engineering.value.approval, engineering.value.plan);
    if (!binding.ok) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: binding.error.message });
    }

    const plan = generateExecutionPlan(body.value.request, body.value.projectId);
    if (!plan.ok) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: plan.error.message });
    }
    const saved = savePreparedExecutionPlan(db, {
      projectId: body.value.projectId,
      idempotencyKey: body.value.idempotencyKey,
      request: body.value.request,
      plan: plan.value,
    });
    if (!saved.ok) throw new Error(saved.error.message);
    return response(saved.value);
  });

  server.get(`${EXECUTION_PLANS_PATH}/:executionPlanId`, {
    schema: {
      params: jsonSchema(ParamsSchema),
      response: {
        200: jsonSchema(PreparedExecutionPlanResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(ParamsSchema, request.params, 'INVALID_EXECUTION_PLAN_PARAMS');
    if (!params.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: params.error.message });
    }
    const prepared = getPreparedExecutionPlan(db, params.value.executionPlanId);
    if (!prepared.ok) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: prepared.error.message });
    }
    return response(prepared.value);
  });
}

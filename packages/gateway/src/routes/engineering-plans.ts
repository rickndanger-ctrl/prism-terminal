import { randomUUID } from 'node:crypto';

import {
  ApprovalStatus,
  EngineeringPlanStatus,
  approvalContractSchema,
  approvePlan,
  createEngineeringPlan,
  engineeringPlanSchema,
  requestApproval,
} from '@codex-lens/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/schema.js';
import {
  getEngineeringPlan,
  saveEngineeringPlan,
  updateEngineeringPlanApproval,
  type PreparedEngineeringPlan,
} from '../engineering-plan-store.js';
import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';
import { getProjectById } from '../registry/registry.js';

export const ENGINEERING_PLANS_PATH = '/v1/engineering-plans';
const nonEmpty = z.string().trim().min(1);
const list = z.array(nonEmpty.max(4_000)).max(100);

export const CreateEngineeringPlanRequestSchema = z.object({
  projectId: nonEmpty,
  idempotencyKey: nonEmpty,
  featureName: nonEmpty.max(500),
  objective: nonEmpty.max(20_000),
  background: z.string().max(20_000),
  requirements: list.min(1),
  constraints: list,
  acceptanceCriteria: list.min(1),
  assumptions: list,
  risks: list,
}).strict();

export const EngineeringPlanResponseSchema = z.object({
  projectId: nonEmpty,
  plan: engineeringPlanSchema,
  approval: approvalContractSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().readonly();

const ParamsSchema = z.object({ engineeringPlanId: nonEmpty }).strict();
const ApproveSchema = z.object({
  version: z.number().int().positive(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const NotFoundSchema = z.object({ statusCode: z.literal(404), error: z.literal('Not Found'), message: nonEmpty }).strict();
const ConflictSchema = z.object({ statusCode: z.literal(409), error: z.literal('Conflict'), message: nonEmpty }).strict();
const UnprocessableSchema = z.object({ statusCode: z.literal(422), error: z.literal('Unprocessable Entity'), message: nonEmpty }).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

function response(prepared: PreparedEngineeringPlan) {
  return {
    projectId: prepared.projectId,
    plan: prepared.plan,
    ...(prepared.approval === undefined ? {} : { approval: prepared.approval }),
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
  };
}

export function registerEngineeringPlanRoutes(server: FastifyInstance, db: Db): void {
  server.post(ENGINEERING_PLANS_PATH, {
    schema: {
      body: jsonSchema(CreateEngineeringPlanRequestSchema),
      response: {
        200: jsonSchema(EngineeringPlanResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        422: jsonSchema(UnprocessableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(CreateEngineeringPlanRequestSchema, request.body, 'INVALID_CREATE_ENGINEERING_PLAN_REQUEST');
    if (!body.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: body.error.message });
    }
    const project = getProjectById(db, body.value.projectId);
    if (!project.ok) {
      const missing = project.error.code === 'PROJECT_NOT_FOUND';
      return reply.code(missing ? 404 : 400).send({
        statusCode: missing ? 404 : 400,
        error: missing ? 'Not Found' : 'Bad Request',
        message: project.error.message,
      });
    }

    const now = new Date().toISOString();
    const created = createEngineeringPlan({
      engineeringPlanId: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      projectName: project.value.displayName,
      featureName: body.value.featureName,
      objective: body.value.objective,
      background: body.value.background,
      requirements: body.value.requirements,
      constraints: body.value.constraints,
      acceptanceCriteria: body.value.acceptanceCriteria,
      assumptions: body.value.assumptions,
      risks: body.value.risks,
      status: EngineeringPlanStatus.Draft,
    });
    if (!created.ok) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: created.error.message });
    }
    const ready = requestApproval(created.value);
    if (!ready.ok) throw new Error(ready.error.message);
    const saved = saveEngineeringPlan(db, {
      projectId: project.value.id,
      idempotencyKey: body.value.idempotencyKey,
      plan: ready.value,
    });
    if (!saved.ok) throw new Error(saved.error.message);
    return response(saved.value);
  });

  server.get(`${ENGINEERING_PLANS_PATH}/:engineeringPlanId`, {
    schema: {
      params: jsonSchema(ParamsSchema),
      response: {
        200: jsonSchema(EngineeringPlanResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(ParamsSchema, request.params, 'INVALID_ENGINEERING_PLAN_PARAMS');
    if (!params.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: params.error.message });
    }
    const found = getEngineeringPlan(db, params.value.engineeringPlanId);
    if (!found.ok) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: found.error.message });
    }
    return response(found.value);
  });

  server.post(`${ENGINEERING_PLANS_PATH}/:engineeringPlanId/approve`, {
    schema: {
      params: jsonSchema(ParamsSchema),
      body: jsonSchema(ApproveSchema),
      response: {
        200: jsonSchema(EngineeringPlanResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        409: jsonSchema(ConflictSchema),
        422: jsonSchema(UnprocessableSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(ParamsSchema, request.params, 'INVALID_ENGINEERING_PLAN_PARAMS');
    const body = validateBoundary(ApproveSchema, request.body, 'INVALID_ENGINEERING_PLAN_APPROVAL');
    if (!params.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: params.error.message });
    }
    if (!body.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: body.error.message });
    }
    const found = getEngineeringPlan(db, params.value.engineeringPlanId);
    if (!found.ok) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: found.error.message });
    }
    if (found.value.approval !== undefined || found.value.plan.status !== EngineeringPlanStatus.ReadyForApproval) {
      return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: 'Engineering plan approval is already resolved' });
    }
    if (found.value.plan.version !== body.value.version || found.value.plan.contentDigest !== body.value.contentDigest) {
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: 'Engineering plan version or digest does not match the reviewed plan' });
    }

    const outcome = approvePlan(found.value.plan, {
      approvalId: randomUUID(),
      approvedBy: 'codex-lens-user',
      approvalTimestamp: new Date().toISOString(),
      approvalType: 'EngineeringPlanApproval',
      notes: 'User approved this exact engineering plan through the authenticated Codex Lens API.',
      pinnedVersion: body.value.version,
      pinnedContentDigest: body.value.contentDigest,
    });
    if (!outcome.ok || outcome.value.approval.approvalStatus !== ApprovalStatus.Approved) {
      const problem = outcome.ok ? 'Engineering plan approval was not approved' : outcome.error.message;
      return reply.code(422).send({ statusCode: 422, error: 'Unprocessable Entity', message: problem });
    }
    const saved = updateEngineeringPlanApproval(db, found.value.plan.engineeringPlanId, outcome.value.plan, outcome.value.approval);
    if (!saved.ok) {
      const conflict = saved.error.code === 'ENGINEERING_PLAN_ALREADY_RESOLVED';
      return reply.code(conflict ? 409 : 422).send({
        statusCode: conflict ? 409 : 422,
        error: conflict ? 'Conflict' : 'Unprocessable Entity',
        message: saved.error.message,
      });
    }
    return response(saved.value);
  });
}

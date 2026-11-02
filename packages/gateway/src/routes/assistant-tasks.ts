import { homedir } from 'node:os';
import { VisualReferencesSchema } from '../assistant/visualReferences.js';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  assistantTaskProjectPolicyFromRegistry,
  createAssistantTaskService,
  type AssistantTaskService,
} from '../assistant/assistantTasks.js';
import { ASSISTANT_TASK_STATES } from '../assistant/assistantTaskStore.js';
import type { Db } from '../db/schema.js';
import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';
import { registerOwnedListenerActivation } from '../lifecycle/listenerActivation.js';
import { getProjectById } from '../registry/registry.js';

export const ASSISTANT_TASKS_PATH = '/v1/assistant-tasks';

const NonEmpty = z.string().trim().min(1);
const PrepareAssistantTaskRequestSchema = z.object({
  instruction: NonEmpty.max(8_000),
  visualReferences: VisualReferencesSchema.optional(),
  scope: z.enum(['project', 'mac']),
  projectId: NonEmpty.max(200).optional(),
  // Callers can only tighten the policy (GPT Live's backend-authored task text).
  requireExplicitConfirmation: z.literal(true).optional(),
}).strict();

const StartAssistantTaskRequestSchema = z.object({
  confirmationId: NonEmpty.max(120),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  authorization: z.enum(['single_utterance', 'explicit_confirmation']),
}).strict();

const TaskParamsSchema = z.object({ taskId: NonEmpty.max(120) }).strict();

const ReconcileAssistantTaskRequestSchema = z.object({
  acknowledgeUnknownOutcome: z.literal(true),
}).strict();

const PreparedAssistantTaskResponseSchema = z.object({
  taskId: NonEmpty,
  confirmationId: NonEmpty,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  instruction: NonEmpty,
  scope: z.enum(['project', 'mac']),
  projectId: NonEmpty.optional(),
  model: NonEmpty,
  reasoningEffort: NonEmpty,
  expiresAt: z.iso.datetime(),
  requiresExplicitConfirmation: z.boolean(),
  confirmationReason: z.string().min(1).max(300).optional(),
}).strict();

const AssistantTaskStatusResponseSchema = z.object({
  taskId: NonEmpty,
  instruction: NonEmpty.max(8_000),
  scope: z.enum(['project', 'mac']),
  projectId: NonEmpty.optional(),
  state: z.enum(ASSISTANT_TASK_STATES),
  model: NonEmpty,
  reasoningEffort: NonEmpty,
  preparedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  threadId: NonEmpty.optional(),
  summary: z.string().min(1).max(1_200).optional(),
  failureCode: NonEmpty.max(120).optional(),
  reconciledAt: z.iso.datetime().optional(),
}).strict();

const NotFoundSchema = z.object({
  statusCode: z.literal(404),
  error: z.literal('Not Found'),
  message: NonEmpty,
}).strict();

const ConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: NonEmpty,
}).strict();

const UnavailableSchema = z.object({
  statusCode: z.literal(503),
  error: z.literal('Service Unavailable'),
  message: NonEmpty,
}).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

function errorStatus(code: string): 404 | 409 | 503 {
  if (code === 'ASSISTANT_TASK_NOT_FOUND' || code === 'ASSISTANT_TASK_CONFIRMATION_NOT_FOUND') return 404;
  if (
    code === 'ASSISTANT_TASK_BUSY'
    || code === 'ASSISTANT_TASK_ALREADY_CONSUMED'
    || code === 'ASSISTANT_TASK_CONFIRMATION_EXPIRED'
    || code === 'ASSISTANT_TASK_CONFIRMATION_MISMATCH'
    || code === 'ASSISTANT_TASK_NOT_ACTIVE'
    || code === 'ASSISTANT_TASK_PROJECT_POLICY_REVOKED'
    || code === 'ASSISTANT_TASK_PROJECT_POLICY_CHANGED'
    || code === 'ASSISTANT_TASK_POLICY_DISALLOWS_ACTION'
    || code === 'ASSISTANT_TASK_PROJECT_ACTION_REQUIRES_MAC_SCOPE'
    || code === 'ASSISTANT_TASK_RECONCILIATION_REQUIRED'
    || code === 'ASSISTANT_TASK_NOT_UNCERTAIN'
    || code === 'ASSISTANT_TASK_RECONCILIATION_CONFLICT'
    || code === 'ASSISTANT_TASK_EXPLICIT_CONFIRMATION_REQUIRED'
    || code === 'ASSISTANT_TASK_SINGLE_UTTERANCE_AUTHORIZATION_REQUIRED'
  ) return 409;
  return 503;
}

function errorBody(status: 404 | 409 | 503, message: string) {
  return {
    statusCode: status,
    error: status === 404
      ? 'Not Found' as const
      : status === 409
        ? 'Conflict' as const
        : 'Service Unavailable' as const,
    message,
  };
}

export function registerAssistantTaskRoutes(
  server: FastifyInstance,
  db: Db,
  service: AssistantTaskService = createAssistantTaskService({ db }),
): void {
  registerOwnedListenerActivation(
    server,
    'assistant task recovery',
    () => service.activate(),
  );

  server.addHook('preClose', async () => {
    await service.close();
  });

  server.post(`${ASSISTANT_TASKS_PATH}/prepare`, {
    schema: {
      body: jsonSchema(PrepareAssistantTaskRequestSchema),
      response: {
        200: jsonSchema(PreparedAssistantTaskResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        409: jsonSchema(ConflictSchema),
        503: jsonSchema(UnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      PrepareAssistantTaskRequestSchema,
      request.body,
      'INVALID_ASSISTANT_TASK_PREPARE',
    );
    if (!body.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: body.error.message });
    }

    let workingDirectory = homedir();
    let projectId: string | undefined;
    let projectPolicy: ReturnType<typeof assistantTaskProjectPolicyFromRegistry> | undefined;
    if (body.value.scope === 'project') {
      if (body.value.projectId === undefined) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'A selected approved project is required for a project task.',
        });
      }
      const project = getProjectById(db, body.value.projectId);
      if (!project.ok) {
        const status = project.error.code === 'PROJECT_NOT_FOUND' ? 404 : 400;
        return reply.code(status).send({
          statusCode: status,
          error: status === 404 ? 'Not Found' : 'Bad Request',
          message: project.error.message,
        });
      }
      if (!project.value.allowWorkspaceWrite) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'The selected project is not approved for workspace changes.',
        });
      }
      workingDirectory = project.value.path;
      projectId = project.value.id;
      projectPolicy = assistantTaskProjectPolicyFromRegistry(project.value);
    } else if (body.value.projectId !== undefined) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'A Mac-wide task must not include a project id.',
      });
    }

    const prepared = await service.prepare({
      instruction: body.value.instruction,
      ...(body.value.visualReferences === undefined ? {} : { visualReferences: body.value.visualReferences }),
      scope: body.value.scope,
      ...(body.value.requireExplicitConfirmation === true ? { requireExplicitConfirmation: true } : {}),
      workingDirectory,
      ...(projectId === undefined ? {} : { projectId }),
      ...(projectPolicy === undefined ? {} : { projectPolicy }),
    });
    if (!prepared.ok) {
      const status = errorStatus(prepared.error.code);
      return reply.code(status).send(errorBody(status, prepared.error.message));
    }
    return prepared.value;
  });

  server.post(`${ASSISTANT_TASKS_PATH}/start`, {
    schema: {
      body: jsonSchema(StartAssistantTaskRequestSchema),
      response: {
        200: jsonSchema(AssistantTaskStatusResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        409: jsonSchema(ConflictSchema),
        503: jsonSchema(UnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      StartAssistantTaskRequestSchema,
      request.body,
      'INVALID_ASSISTANT_TASK_START',
    );
    if (!body.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: body.error.message });
    }
    const started = await service.start(body.value);
    if (!started.ok) {
      const status = errorStatus(started.error.code);
      return reply.code(status).send(errorBody(status, started.error.message));
    }
    return started.value;
  });

  server.get(`${ASSISTANT_TASKS_PATH}/:taskId`, {
    schema: {
      params: jsonSchema(TaskParamsSchema),
      response: {
        200: jsonSchema(AssistantTaskStatusResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(TaskParamsSchema, request.params, 'INVALID_ASSISTANT_TASK_PARAMS');
    if (!params.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: params.error.message });
    }
    const status = await service.status(params.value.taskId);
    if (!status.ok) return reply.code(404).send(errorBody(404, status.error.message));
    return status.value;
  });

  server.post(`${ASSISTANT_TASKS_PATH}/:taskId/cancel`, {
    schema: {
      params: jsonSchema(TaskParamsSchema),
      response: {
        200: jsonSchema(AssistantTaskStatusResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        409: jsonSchema(ConflictSchema),
        503: jsonSchema(UnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(TaskParamsSchema, request.params, 'INVALID_ASSISTANT_TASK_PARAMS');
    if (!params.ok) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: params.error.message });
    }
    const cancelled = await service.cancel(params.value.taskId);
    if (!cancelled.ok) {
      const status = errorStatus(cancelled.error.code);
      return reply.code(status).send(errorBody(status, cancelled.error.message));
    }
    return cancelled.value;
  });

  server.post(`${ASSISTANT_TASKS_PATH}/:taskId/reconcile`, {
    schema: {
      params: jsonSchema(TaskParamsSchema),
      body: jsonSchema(ReconcileAssistantTaskRequestSchema),
      response: {
        200: jsonSchema(AssistantTaskStatusResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        404: jsonSchema(NotFoundSchema),
        409: jsonSchema(ConflictSchema),
        503: jsonSchema(UnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(
      TaskParamsSchema,
      request.params,
      'INVALID_ASSISTANT_TASK_PARAMS',
    );
    if (!params.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: params.error.message,
      });
    }
    const body = validateBoundary(
      ReconcileAssistantTaskRequestSchema,
      request.body,
      'INVALID_ASSISTANT_TASK_RECONCILIATION',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    const reconciled = await service.reconcile(params.value.taskId);
    if (!reconciled.ok) {
      const status = errorStatus(reconciled.error.code);
      return reply.code(status).send(errorBody(status, reconciled.error.message));
    }
    return reconciled.value;
  });
}

import { type Result } from '@codex-lens/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/schema.js';
import { CodexLensEventSchema } from '../events/event.js';
import { listEventsAfter } from '../events/eventStore.js';
import {
  BoundaryBadRequestSchema,
  validateBoundary,
} from '../http/validation.js';
import { resolveWorkingDir } from '../registry/pathSafety.js';
import { getProjectById } from '../registry/registry.js';
import { runMockTask } from '../runner/mockRunner.js';
import { runCodexTask } from '../runner/codexRunner.js';
import {
  getPreparedExecutionPlan,
  type PreparedExecutionPlan,
} from '../execution-plan-store.js';
import type { RegistryRecord } from '../registry/projectRegistry.js';
import { TaskSchema } from '../tasks/task.js';
import type { Task } from '../tasks/task.js';
import { bindTaskRun } from '../tasks/taskRunStore.js';
import { createTask, getTaskById } from '../tasks/taskStore.js';

export const TASKS_PATH = '/v1/tasks';

const nonEmptyString = z.string().trim().min(1);

export const CreateTaskRequestSchema = z
  .object({
    projectId: nonEmptyString,
    idempotencyKey: nonEmptyString,
    requestedPath: z.string().min(1).optional(),
    executionPlanId: nonEmptyString.optional(),
    executionPlanDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  })
  .strict();

export type CreateTaskRequest = z.output<typeof CreateTaskRequestSchema>;

export const TaskParamsSchema = z
  .object({
    taskId: nonEmptyString,
  })
  .strict();

export const TaskResponseSchema = TaskSchema;

/**
 * Optional `?after=<seq>` streams only events newer than a cursor. Omitted
 * (or -1) returns the whole log. Fastify coerces the query string to an
 * integer against this schema.
 */
export const TaskEventsQuerySchema = z
  .object({
    after: z.coerce.number().int().min(-1).optional(),
  })
  .strict();

export type TaskEventsQuery = z.output<typeof TaskEventsQuerySchema>;

export const TaskEventsResponseSchema = z
  .object({
    events: z.array(CodexLensEventSchema).readonly(),
    // The cursor to pass as `after` next poll: the highest seq returned, or
    // the incoming cursor when nothing is new (so it never rewinds).
    nextCursor: z.number().int().min(-1),
  })
  .strict()
  .readonly();

export type TaskEventsResponse = z.output<typeof TaskEventsResponseSchema>;

export const TaskNotFoundSchema = z
  .object({
    statusCode: z.literal(404),
    error: z.literal('Not Found'),
    message: z.string().min(1),
  })
  .strict();

export const TaskUnprocessableSchema = z
  .object({
    statusCode: z.literal(422),
    error: z.literal('Unprocessable Entity'),
    message: z.string().min(1),
  })
  .strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

const badRequestJsonSchema = jsonSchema(BoundaryBadRequestSchema);
const notFoundJsonSchema = jsonSchema(TaskNotFoundSchema);
const unprocessableJsonSchema = jsonSchema(TaskUnprocessableSchema);
const taskJsonSchema = jsonSchema(TaskResponseSchema);

export type TaskRunner = (
  db: Db,
  task: Task,
  project: RegistryRecord,
  prepared?: PreparedExecutionPlan,
) => Promise<Result<unknown>>;

const defaultTaskRunner: TaskRunner = async (db, task, project, prepared) =>
  prepared === undefined
    ? runMockTask(db, task, project)
    : runCodexTask(db, task, project, prepared);

export function registerTasksRoutes(
  server: FastifyInstance,
  db: Db,
  taskRunner: TaskRunner = defaultTaskRunner,
): void {
  server.post(
    TASKS_PATH,
    {
      schema: {
        body: jsonSchema(CreateTaskRequestSchema),
        response: {
          200: taskJsonSchema,
          400: badRequestJsonSchema,
          404: notFoundJsonSchema,
          422: unprocessableJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const body = validateBoundary(
        CreateTaskRequestSchema,
        request.body,
        'INVALID_CREATE_TASK_REQUEST',
      );
      if (!body.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: body.error.message,
        });
      }

      const project = getProjectById(db, body.value.projectId);
      if (!project.ok) {
        if (project.error.code === 'PROJECT_NOT_FOUND') {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: project.error.message,
          });
        }
        if (project.error.code === 'INVALID_PROJECT_ID') {
          return reply.code(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: project.error.message,
          });
        }
        throw new Error(project.error.message);
      }

      const workingDir = resolveWorkingDir(
        project.value,
        body.value.requestedPath,
      );
      if (!workingDir.ok) {
        return reply.code(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: workingDir.error.message,
        });
      }

      const hasExecutionPlanId = body.value.executionPlanId !== undefined;
      const hasExecutionPlanDigest = body.value.executionPlanDigest !== undefined;
      if (hasExecutionPlanId !== hasExecutionPlanDigest) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'executionPlanId and executionPlanDigest must be supplied together.',
        });
      }

      let prepared: PreparedExecutionPlan | undefined;
      if (body.value.executionPlanId !== undefined && body.value.executionPlanDigest !== undefined) {
        const loaded = getPreparedExecutionPlan(db, body.value.executionPlanId);
        if (!loaded.ok) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: loaded.error.message,
          });
        }
        if (
          loaded.value.projectId !== project.value.id ||
          loaded.value.plan.contentDigest !== body.value.executionPlanDigest
        ) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: 'Execution plan id, digest, and project do not match the stored reviewed plan.',
          });
        }
        prepared = loaded.value;
      }

      const task = createTask(db, {
        projectId: body.value.projectId,
        idempotencyKey: body.value.idempotencyKey,
      });
      if (!task.ok) {
        throw new Error(task.error.message);
      }
      if (prepared !== undefined) {
        const bound = bindTaskRun(
          db,
          task.value.id,
          prepared.plan.executionPlanId,
          prepared.plan.contentDigest,
        );
        if (!bound.ok) {
          return reply.code(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: bound.error.message,
          });
        }
      }

      // Only a freshly created task is still queued; an idempotent replay
      // returns a task the runner already claimed, so it is not re-run. The
      // claim inside runMockTask makes an accidental double kick harmless.
      if (task.value.state === 'queued') {
        const created = task.value;
        void taskRunner(db, created, project.value, prepared)
          .then((run) => {
            if (!run.ok) {
              request.log.error(
                { taskId: created.id, code: run.error.code },
                run.error.message,
              );
            }
          })
          .catch((error: unknown) => {
            request.log.error({ taskId: created.id, err: error }, 'mock runner crashed');
          });
      }

      const response = validateBoundary(
        TaskResponseSchema,
        task.value,
        'INVALID_TASK_RESPONSE',
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      return response.value;
    },
  );

  server.get(
    `${TASKS_PATH}/:taskId`,
    {
      schema: {
        params: jsonSchema(TaskParamsSchema),
        response: {
          200: taskJsonSchema,
          400: badRequestJsonSchema,
          404: notFoundJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const params = validateBoundary(
        TaskParamsSchema,
        request.params,
        'INVALID_TASK_PARAMS',
      );
      if (!params.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: params.error.message,
        });
      }

      const task = getTaskById(db, params.value.taskId);
      if (!task.ok) {
        if (task.error.code === 'TASK_NOT_FOUND') {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: task.error.message,
          });
        }
        throw new Error(task.error.message);
      }

      const response = validateBoundary(
        TaskResponseSchema,
        task.value,
        'INVALID_TASK_RESPONSE',
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      return response.value;
    },
  );

  server.get(
    `${TASKS_PATH}/:taskId/events`,
    {
      schema: {
        params: jsonSchema(TaskParamsSchema),
        querystring: jsonSchema(TaskEventsQuerySchema),
        response: {
          200: jsonSchema(TaskEventsResponseSchema),
          400: badRequestJsonSchema,
          404: notFoundJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const params = validateBoundary(
        TaskParamsSchema,
        request.params,
        'INVALID_TASK_PARAMS',
      );
      if (!params.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: params.error.message,
        });
      }

      const query = validateBoundary(
        TaskEventsQuerySchema,
        request.query,
        'INVALID_TASK_EVENTS_QUERY',
      );
      if (!query.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: query.error.message,
        });
      }

      const task = getTaskById(db, params.value.taskId);
      if (!task.ok) {
        if (task.error.code === 'TASK_NOT_FOUND') {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: task.error.message,
          });
        }
        throw new Error(task.error.message);
      }

      const cursor = query.value.after ?? -1;
      const events = listEventsAfter(db, params.value.taskId, cursor);
      if (!events.ok) {
        throw new Error(events.error.message);
      }

      const lastEvent = events.value.at(-1);
      const nextCursor = lastEvent === undefined ? cursor : lastEvent.seq;

      const response = validateBoundary(
        TaskEventsResponseSchema,
        { events: events.value, nextCursor },
        'INVALID_TASK_EVENTS_RESPONSE',
      );
      if (!response.ok) {
        throw new Error(response.error.message);
      }

      return response.value;
    },
  );
}

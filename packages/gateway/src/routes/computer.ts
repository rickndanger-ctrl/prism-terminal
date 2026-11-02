import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  closeFrontmostComputerWindow,
  controlComputer,
  focusComputerApp,
  inspectComputer,
  readFrontmostComputerApp,
  setFrontmostComputerWindowState,
  type ComputerAppFocuser,
  type ComputerWindowCloser,
  type ComputerWindowStateSetter,
  type ComputerController,
  type ComputerInspector,
  type FrontmostComputerAppReader,
} from '../computer/codexComputer.js';
import {
  createComputerActionService,
  type ComputerActionService,
} from '../computer/computerActions.js';
import { BoundaryBadRequestSchema, validateBoundary } from '../http/validation.js';

export const COMPUTER_INSPECT_PATH = '/v1/computer/inspect';
export const COMPUTER_FRONTMOST_PATH = '/v1/computer/frontmost';
export const COMPUTER_FOCUS_PATH = '/v1/computer/focus';
export const COMPUTER_CLOSE_WINDOW_PATH = '/v1/computer/close-window';
export const COMPUTER_WINDOW_STATE_PATH = '/v1/computer/window-state';
export const COMPUTER_USE_PATH = '/v1/computer/use';
export const COMPUTER_PREPARE_PATH = '/v1/computer/prepare';
export const COMPUTER_EXECUTE_PATH = '/v1/computer/execute';
export const COMPUTER_CANCEL_PATH = '/v1/computer/actions/:confirmationId/cancel';

export const ComputerInspectRequestSchema = z.object({
  app: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(500),
}).strict();

export const ComputerInspectResponseSchema = z.object({
  app: z.string().min(1),
  summary: z.string().min(1),
}).strict();

export const FrontmostComputerAppResponseSchema = z.object({
  app: z.string().min(1).max(120),
  windowTitle: z.string().min(1).max(500).optional(),
  readOnly: z.literal(true),
}).strict();

export const FocusComputerAppRequestSchema = z.object({
  app: z.string().trim().min(1).max(120),
}).strict();

export const FocusedComputerAppResponseSchema = z.object({
  app: z.string().min(1).max(120),
  frontmost: z.literal(true),
}).strict();

export const ClosedComputerWindowResponseSchema = z.object({
  app: z.string().min(1).max(120),
  windowTitle: z.string().min(1).max(500).optional(),
  closed: z.boolean(),
  needsUserDecision: z.boolean(),
}).strict();

export const ComputerWindowStateRequestSchema = z.object({
  action: z.enum(['minimize', 'restore']),
}).strict();

export const ComputerWindowStateResponseSchema = z.object({
  app: z.string().min(1).max(120),
  windowTitle: z.string().min(1).max(500).optional(),
  action: z.enum(['minimize', 'restore']),
  applied: z.literal(true),
  minimized: z.boolean(),
}).strict();

export const PrepareComputerActionRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(2_000),
  surface: z.enum(['auto', 'computer', 'chrome']).default('auto'),
}).strict();

export const PreparedComputerActionResponseSchema = z.object({
  confirmationId: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  instruction: z.string().min(1).max(2_000),
  surface: z.enum(['auto', 'computer', 'chrome']),
  expiresAt: z.iso.datetime(),
  requiresExplicitConfirmation: z.boolean(),
  confirmationReason: z.string().min(1).max(300).optional(),
}).strict();

export const ExecuteComputerActionRequestSchema = z.object({
  confirmationId: z.string().trim().min(1).max(120),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  authorization: z.enum(['single_utterance', 'explicit_confirmation']),
}).strict();

export const ExecutedComputerActionResponseSchema = z.object({
  completed: z.boolean(),
  confirmationRequired: z.boolean(),
  summary: z.string().min(1).max(800),
  surface: z.enum(['auto', 'computer', 'chrome']),
}).strict();

const ComputerActionParamsSchema = z.object({
  confirmationId: z.string().trim().min(1).max(120),
}).strict();

export const CancelledComputerActionResponseSchema = z.object({
  confirmationId: z.string().min(1).max(120),
  cancelled: z.boolean(),
  outcomeUncertain: z.boolean(),
  summary: z.string().min(1).max(800),
}).strict();

const ComputerActionErrorSchema = z.object({
  statusCode: z.union([z.literal(409), z.literal(422), z.literal(503)]),
  error: z.union([z.literal('Conflict'), z.literal('Unprocessable Entity'), z.literal('Service Unavailable')]),
  message: z.string().min(1),
}).strict();

const ComputerUnavailableSchema = z.object({
  statusCode: z.literal(503),
  error: z.literal('Service Unavailable'),
  message: z.string().min(1),
}).strict();

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

export function registerComputerRoutes(
  server: FastifyInstance,
  inspector: ComputerInspector = inspectComputer,
  controller: ComputerController = controlComputer,
  actionService?: ComputerActionService,
  frontmostReader: FrontmostComputerAppReader = readFrontmostComputerApp,
  appFocuser: ComputerAppFocuser = focusComputerApp,
  windowCloser: ComputerWindowCloser = closeFrontmostComputerWindow,
  windowStateSetter: ComputerWindowStateSetter = setFrontmostComputerWindowState,
): void {
  const actions = actionService ?? createComputerActionService({ control: controller });
  server.get(COMPUTER_FRONTMOST_PATH, {
    schema: {
      response: {
        200: jsonSchema(FrontmostComputerAppResponseSchema),
        503: jsonSchema(ComputerUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const result = await frontmostReader();
    if (!result.ok) {
      request.log.warn({ code: result.error.code }, 'frontmost app read failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: result.error.message,
      });
    }
    return { ...result.value, readOnly: true as const };
  });

  server.post(COMPUTER_FOCUS_PATH, {
    schema: {
      body: jsonSchema(FocusComputerAppRequestSchema),
      response: {
        200: jsonSchema(FocusedComputerAppResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        503: jsonSchema(ComputerUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      FocusComputerAppRequestSchema,
      request.body,
      'INVALID_COMPUTER_FOCUS_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    const result = await appFocuser(body.value);
    if (!result.ok) {
      request.log.warn({ code: result.error.code }, 'app focus failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: result.error.message,
      });
    }
    return result.value;
  });

  server.post(COMPUTER_CLOSE_WINDOW_PATH, {
    schema: {
      response: {
        200: jsonSchema(ClosedComputerWindowResponseSchema),
        503: jsonSchema(ComputerUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const result = await windowCloser();
    if (!result.ok) {
      request.log.warn({ code: result.error.code }, 'frontmost window close failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: result.error.message,
      });
    }
    return result.value;
  });

  server.post(COMPUTER_WINDOW_STATE_PATH, {
    schema: {
      body: jsonSchema(ComputerWindowStateRequestSchema),
      response: {
        200: jsonSchema(ComputerWindowStateResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        503: jsonSchema(ComputerUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      ComputerWindowStateRequestSchema,
      request.body,
      'INVALID_COMPUTER_WINDOW_STATE_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }
    const result = await windowStateSetter(body.value);
    if (!result.ok) {
      request.log.warn({ code: result.error.code }, 'frontmost window state change failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: result.error.message,
      });
    }
    return result.value;
  });

  server.post(COMPUTER_INSPECT_PATH, {
    schema: {
      body: jsonSchema(ComputerInspectRequestSchema),
      response: {
        200: jsonSchema(ComputerInspectResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        503: jsonSchema(ComputerUnavailableSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      ComputerInspectRequestSchema,
      request.body,
      'INVALID_COMPUTER_INSPECTION_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }

    const inspected = await inspector(body.value);
    if (!inspected.ok) {
      request.log.warn({ code: inspected.error.code }, 'computer inspection failed');
      return reply.code(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        message: inspected.error.message,
      });
    }
    return inspected.value;
  });

  server.post(COMPUTER_USE_PATH, {
    schema: {
      body: jsonSchema(PrepareComputerActionRequestSchema),
      response: {
        400: jsonSchema(BoundaryBadRequestSchema),
        422: jsonSchema(ComputerActionErrorSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      PrepareComputerActionRequestSchema,
      request.body,
      'INVALID_COMPUTER_USE_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }

    // Arbitrary model-driven GUI actions must cross the one-time prepare and
    // execute confirmation boundary. Keep this legacy endpoint fail-closed so
    // an older client cannot silently retain ordinary model authority.
    return reply.code(422).send({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Model-driven computer actions must be prepared and separately confirmed before execution.',
    });
  });

  server.post(COMPUTER_PREPARE_PATH, {
    schema: {
      body: jsonSchema(PrepareComputerActionRequestSchema),
      response: {
        200: jsonSchema(PreparedComputerActionResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      PrepareComputerActionRequestSchema,
      request.body,
      'INVALID_COMPUTER_PREPARE_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }

    const prepared = await actions.prepare(body.value);
    if (!prepared.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: prepared.error.message,
      });
    }
    return prepared.value;
  });

  server.post(COMPUTER_EXECUTE_PATH, {
    schema: {
      body: jsonSchema(ExecuteComputerActionRequestSchema),
      response: {
        200: jsonSchema(ExecutedComputerActionResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        422: jsonSchema(ComputerActionErrorSchema),
        503: jsonSchema(ComputerActionErrorSchema),
      },
    },
  }, async (request, reply) => {
    const body = validateBoundary(
      ExecuteComputerActionRequestSchema,
      request.body,
      'INVALID_COMPUTER_EXECUTE_REQUEST',
    );
    if (!body.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: body.error.message,
      });
    }

    const executed = await actions.execute(body.value);
    if (!executed.ok) {
      const unavailable = executed.error.code.startsWith('COMPUTER_CONTROL_');
      request.log.warn({ code: executed.error.code }, 'computer control failed');
      return reply.code(unavailable ? 503 : 422).send({
        statusCode: unavailable ? 503 : 422,
        error: unavailable ? 'Service Unavailable' : 'Unprocessable Entity',
        message: executed.error.message,
      });
    }
    return executed.value;
  });

  server.post(COMPUTER_CANCEL_PATH, {
    schema: {
      params: jsonSchema(ComputerActionParamsSchema),
      response: {
        200: jsonSchema(CancelledComputerActionResponseSchema),
        400: jsonSchema(BoundaryBadRequestSchema),
        409: jsonSchema(ComputerActionErrorSchema),
      },
    },
  }, async (request, reply) => {
    const params = validateBoundary(
      ComputerActionParamsSchema,
      request.params,
      'INVALID_COMPUTER_CANCEL_REQUEST',
    );
    if (!params.ok) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: params.error.message,
      });
    }
    const cancelled = await actions.cancel(params.value.confirmationId);
    if (!cancelled.ok) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: cancelled.error.message,
      });
    }
    return cancelled.value;
  });
}

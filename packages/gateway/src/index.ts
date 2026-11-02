import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { waitForOwnedListenerActivations } from './lifecycle/listenerActivation.js';
import { buildServer } from './server.js';
import { createGmailRuntime } from './email/gmailRuntime.js';

export { assertExecutionApproved } from './approval-binding.js';

export const GATEWAY_HOST = '127.0.0.1';
export const GATEWAY_DB_PATH_ENV = 'CODEX_LENS_DB_PATH';
const DEFAULT_PORT = 8787;

interface GatewaySignalTarget {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface GatewayShutdownController {
  shutdown(): Promise<void>;
}

export function installGatewayShutdownHandlers(
  server: FastifyInstance,
  signalTarget: GatewaySignalTarget = process,
): GatewayShutdownController {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= server.close();
    await shutdownPromise;
  };
  const onSignal = (): void => {
    void shutdown().catch((error: unknown) => {
      server.log.error({ err: error }, 'Codex Lens gateway shutdown failed');
      process.exitCode = 1;
    });
  };
  signalTarget.once('SIGINT', onSignal);
  signalTarget.once('SIGTERM', onSignal);
  server.addHook('onClose', async () => {
    signalTarget.off('SIGINT', onSignal);
    signalTarget.off('SIGTERM', onSignal);
  });
  return { shutdown };
}

export async function start(
  createServer: typeof buildServer = buildServer,
): Promise<void> {
  const dbPath = process.env[GATEWAY_DB_PATH_ENV];
  const port = Number.parseInt(process.env.CODEX_LENS_PORT ?? `${DEFAULT_PORT}`, 10);
  const clientId = process.env.CODEX_LENS_GOOGLE_CLIENT_ID;
  // The fixed Keychain slot belongs to the canonical listener only. Test or
  // secondary gateways on another port must not share its account controller.
  const gmail = clientId && port === DEFAULT_PORT ? createGmailRuntime({ clientId,
    ...(process.env.CODEX_LENS_GOOGLE_CLIENT_SECRET === undefined ? {} : {
      clientSecret: process.env.CODEX_LENS_GOOGLE_CLIENT_SECRET,
    }) }) : undefined;
  const server = createServer({
    ...(dbPath === undefined || dbPath.trim() === '' ? {} : { dbPath }),
    ...(gmail ? { gmailConnection: gmail.connection, gmailReader: gmail.reader, gmailIdentity: gmail.identity,
      gmailWriterFactory: gmail.writerForDb } : {}),
  });
  server.addHook('onClose', async () => { await gmail?.close(); });

  const shutdownController = installGatewayShutdownHandlers(server);

  try {
    await server.listen({
      host: GATEWAY_HOST,
      port,
    });
    await waitForOwnedListenerActivations(server);
    if (server.server.listening) await gmail?.activate();
  } catch (error) {
    await shutdownController.shutdown().catch(() => undefined);
    throw error;
  }
  server.log.info({ host: GATEWAY_HOST, port }, 'Codex Lens gateway started');
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await start();
}

export { buildServer } from './server.js';
export {
  RegistryRecordSchema,
  assertCommandAllowed,
  canonicalizePath,
  getProjectById,
  isInsideRootLexically,
  isWithinRoot,
  loadRegistry,
  parseRegistryRecord,
  projectRegistryRecordSchema,
  resolveWorkingDir,
  seedRegistry,
} from './registry/index.js';
export type { RegistryRecord, RegistryRecordInput } from './registry/index.js';
export { assertEditableTarget, resolveRepo } from './registry.js';
export type { RegisteredRepo } from './registry.js';
export {
  CODEX_LENS_REPO_ID,
  CODEX_LENS_REPO_ROOT,
  REPO_REGISTRY,
  SAMPLE_REPO_ID,
  SAMPLE_REPO_ROOT,
} from './registryConfig.js';
export type { RepoRegistryEntry } from './registryConfig.js';
export {
  AppendEventSchema,
  CODEX_LENS_EVENT_TYPES,
  CodexLensEventSchema,
  appendEvent,
  listEvents,
  listEventsAfter,
  parseCodexLensEvent,
} from './events/index.js';
export type { AppendEventInput, CodexLensEvent } from './events/index.js';
export {
  CreateTaskSchema,
  TASK_STATES,
  TaskSchema,
  createTask,
  getTaskById,
  parseCreateTaskInput,
  parseTask,
  transitionTask,
} from './tasks/index.js';
export type { CreateTaskInput, Task, TaskState } from './tasks/index.js';
export { runMockTask } from './runner/index.js';
export type { MockRunOptions, MockRunResult } from './runner/index.js';
export {
  SAMPLE_REPO_TEST_COMMAND,
  generateExecutionPlan,
} from './plan-generation.js';
export type { ExecutionPlanRequest } from './plan-generation.js';
export { runTests } from './test-runner.js';
export type { Sandbox, TestCounts, TestRun } from './test-runner.js';
export {
  readSandboxCleanupFailure,
  runVerticalSlice,
  SANDBOX_CLEANUP_FAILED,
} from './orchestrator.js';
export type {
  ExecutionApproval,
  ExecutionApprovalIssuer,
  SandboxCleanupFailure,
  VerticalSliceOptions,
  VerticalSliceReport,
} from './orchestrator.js';
export {
  CODEX_AUTH_UNAVAILABLE,
  createThread,
  initialize,
  isAuthUnavailable,
  resumeThread,
} from './codex/client.js';
export type {
  CodexClientOptions,
  CodexCreateThreadOptions,
  CodexInitializeOptions,
  CodexInitializeResult,
  CodexThread,
} from './codex/client.js';
export { applyEdit } from './codex/apply-edit.js';
export type { AppliedEdit } from './codex/apply-edit.js';
export { startAppServer } from './codex/transport.js';
export type {
  AppServerHandle,
  AppServerMessage,
  AppServerMessageListener,
  StartAppServerOptions,
} from './codex/transport.js';
export { HealthRequestSchema, HealthResponseSchema } from './routes/health.js';
export type { HealthResponse } from './routes/health.js';
export {
  PROJECTS_PATH,
  ProjectsRequestSchema,
  ProjectsResponseSchema,
} from './routes/projects.js';
export type { ProjectsResponse } from './routes/projects.js';
export {
  CreateTaskRequestSchema,
  TASKS_PATH,
  TaskEventsQuerySchema,
  TaskEventsResponseSchema,
  TaskParamsSchema,
  TaskResponseSchema,
} from './routes/tasks.js';
export type {
  CreateTaskRequest,
  TaskEventsQuery,
  TaskEventsResponse,
} from './routes/tasks.js';
export {
  DEFAULT_REALTIME_MODEL,
  OPENAI_API_KEY_ENV,
  REALTIME_CREDENTIALS_PATH,
  RealtimeCredentialRequestSchema,
  RealtimeCredentialSchema,
  createOpenAiRealtimeIssuer,
  realtimeIssuerFromEnv,
} from './realtime/credentials.js';
export type {
  OpenAiRealtimeIssuerOptions,
  RealtimeCredential,
  RealtimeCredentialIssuer,
  RealtimeCredentialRequest,
} from './realtime/credentials.js';
export {
  GPT_LIVE_CALLS_PATH,
  GPT_LIVE_MODEL,
  createGptLiveSessionStarter,
  gptLiveSessionStarterFromEnv,
} from './realtime/gptLive.js';
export type {
  GptLiveSessionStarter,
  GptLiveSessionStarterOptions,
} from './realtime/gptLive.js';
export {
  ASSISTANT_TASKS_PATH,
  registerAssistantTaskRoutes,
} from './routes/assistant-tasks.js';
export {
  createAssistantTaskService,
} from './assistant/assistantTasks.js';
export type {
  AssistantTaskService,
  AssistantTaskStatus,
  PreparedAssistantTask,
} from './assistant/assistantTasks.js';
export {
  REASONING_ANSWER_PATH,
  ReasoningAnswerRequestSchema,
  registerReasoningRoutes,
} from './routes/reasoning.js';
export {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_MODEL,
  REASONING_INSTRUCTIONS,
  ReasoningAnswerSchema,
  createOpenAiReasoningAnswerer,
  reasoningAnswererFromEnv,
} from './reasoning/answer.js';
export type {
  OpenAiReasoningAnswererOptions,
  ReasoningAnswer,
  ReasoningAnswerer,
} from './reasoning/answer.js';
export { registerRealtimeRoute } from './routes/realtime.js';
export { registerGptLiveRealtimeRoutes } from './routes/gptLiveRealtime.js';

import { TerminalService } from './terminal/service.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerCommandPadRoutes } from './routes/commandPad.js';
import { localSpeechFromEnv, type LocalSpeechService } from './voice/speech.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { GATEWAY_BUILD_IDENTITY } from './buildIdentity.js';
import { registerGmailRoutes } from './routes/gmail.js';
import { registerGmailWriteRoutes } from './routes/gmail-write.js';
import type { createGmailWriter } from './email/gmailWriter.js';
import { registerGmailReadRoutes } from './routes/gmail-read.js';
import type { GmailReader } from './email/gmailReader.js';
import type { GmailIdentity } from './email/gmailIdentity.js';
import type { createGmailConnection } from './email/gmailConnection.js';

import { registerAuth } from './auth/index.js';
import { openDb, type Db } from './db/schema.js';
import {
  realtimeIssuerFromEnv,
  type RealtimeCredentialIssuer,
} from './realtime/credentials.js';
import { registerHealthRoute } from './routes/health.js';
import { registerProjectsRoute } from './routes/projects.js';
import { registerRealtimeRoute } from './routes/realtime.js';
import { registerGeminiRealtimeRoutes } from './routes/geminiRealtime.js';
import type { GeminiSessionPool } from './realtime/geminiSessionPool.js';
import { registerGptLiveRealtimeRoutes } from './routes/gptLiveRealtime.js';
import {
  gptLiveSessionStarterFromEnv,
  type GptLiveSessionStarter,
} from './realtime/gptLive.js';
import { registerTasksRoutes } from './routes/tasks.js';
import { registerEngineeringPlanRoutes } from './routes/engineering-plans.js';
import { registerExecutionPlanRoutes } from './routes/execution-plans.js';
import type { TaskRunner } from './routes/tasks.js';
import { registerComputerRoutes } from './routes/computer.js';
import type {
  ComputerAppFocuser,
  ComputerController,
  ComputerInspector,
  ComputerWindowCloser,
  ComputerWindowStateSetter,
  FrontmostComputerAppReader,
} from './computer/codexComputer.js';
import { registerMessageRoutes } from './routes/messages.js';
import { createMessageService, type MessageService } from './messages/messages.js';
import { registerCodexRoutes, type CodexProjectInspector } from './routes/codex.js';
import { registerWebRoutes } from './routes/web.js';
import { webResearcherFromEnv, type WebResearcher } from './web/research.js';
import { registerAssistantTaskRoutes } from './routes/assistant-tasks.js';
import { createAssistantTaskService, type AssistantTaskService } from './assistant/assistantTasks.js';
import { registerReasoningRoutes } from './routes/reasoning.js';
import {
  reasoningAnswererFromEnv,
  type ReasoningAnswerer,
} from './reasoning/answer.js';

export const GATEWAY_VERSION = `0.0.0+${GATEWAY_BUILD_IDENTITY}`;

export interface BuildServerOptions {
  gmailWriterFactory?: (db: Db) => ReturnType<typeof createGmailWriter>;
  gmailConnection?: ReturnType<typeof createGmailConnection>;
  gmailReader?: GmailReader;
  gmailIdentity?: GmailIdentity;
  db?: Db;
  dbPath?: string;
  version?: string;
  /**
   * Mints short-lived OpenAI Realtime credentials. Injected for tests;
   * otherwise built from OPENAI_API_KEY, and absent (route fails closed with
   * 503) when no key is configured.
   */
  realtimeCredentialIssuer?: RealtimeCredentialIssuer;
  /** Disabled unless the host explicitly supplies the complete experimental runtime. */
  geminiSessions?: GeminiSessionPool;
  /**
   * Starts OpenAI GPT-Live sessions. Injected for tests; otherwise built from
   * OPENAI_API_KEY, and absent (routes fail closed with 503) when no key is configured.
   */
  gptLiveSessionStarter?: GptLiveSessionStarter;
  /** Performs one policy-bounded, read-only Mac app inspection. */
  computerInspector?: ComputerInspector;
  /** Reads only the active Mac app name without starting a model. */
  frontmostComputerAppReader?: FrontmostComputerAppReader;
  /** Opens or activates one named Mac app through the deterministic fast path. */
  computerAppFocuser?: ComputerAppFocuser;
  /** Closes only the current main window and never resolves save dialogs. */
  computerWindowCloser?: ComputerWindowCloser;
  /** Minimizes or restores the current main window and verifies the result. */
  computerWindowStateSetter?: ComputerWindowStateSetter;
  /** Operates Mac apps and Chrome for an explicit user-directed task. */
  computerController?: ComputerController;
  /** Resolves, prepares, and confirmation-gates Messages sends. */
  messageService?: MessageService;
  /** Runs an approved task. Injectable so route tests never start Codex. */
  taskRunner?: TaskRunner;
  /** Performs a direct, read-only Codex inspection of an allowlisted project. */
  codexProjectInspector?: CodexProjectInspector;
  /** Answers current-information questions using OpenAI's read-only web search. */
  webResearcher?: WebResearcher;
  /** Owns durable, one-at-a-time, task-bounded Codex work. */
  assistantTaskService?: AssistantTaskService;
  terminalService?: TerminalService;
  localSpeechService?: LocalSpeechService;
  /** Answers general questions without tools or live/private data access. */
  reasoningAnswerer?: ReasoningAnswerer;
}

const REDACTED_LOG_FIELDS = [
  'authorization',
  'token',
  'credential',
  'apiKey',
  'req.headers.authorization',
  '*.authorization',
  '*.token',
  '*.credential',
  '*.apiKey',
  'question',
  '*.question',
  'instruction',
  '*.instruction',
  'recipient',
  'message',
  'confirmationId',
  'digest',
  '*.recipient',
  '*.message',
  '*.confirmationId',
  '*.digest',
];

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    logger: {
      redact: {
        paths: REDACTED_LOG_FIELDS,
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
        res(response) {
          return {
            statusCode: response.statusCode,
          };
        },
      },
    },
  });

  const db = options.db ?? openDb(options.dbPath ?? ':memory:');
  const gmailWriter = options.gmailWriterFactory?.(db);
  if (options.db === undefined) {
    server.addHook('onClose', async () => {
      await gmailWriter?.close();
      db.close();
    });
  } else {
    server.addHook('onClose', async () => { await gmailWriter?.close(); });
  }

  registerAuth(server);
  registerGmailWriteRoutes(server, gmailWriter);
  registerGmailRoutes(server, options.gmailConnection, options.gmailIdentity);
  registerGmailReadRoutes(server, options.gmailReader);
  registerHealthRoute(server, options.version ?? GATEWAY_VERSION);
  registerProjectsRoute(server, db);
  registerEngineeringPlanRoutes(server, db);
  registerExecutionPlanRoutes(server, db);
  registerTasksRoutes(server, db, options.taskRunner);
  let padBusy = () => false;
  const terminal = options.terminalService ?? new TerminalService({ db, externalBusy: () => padBusy() });
  registerTerminalRoutes(server, terminal);
  padBusy = registerCommandPadRoutes(server, db, () => terminal.store.busy());
  registerVoiceRoutes(server, options.localSpeechService ?? localSpeechFromEnv());
  registerAssistantTaskRoutes(server, db, options.assistantTaskService ?? createAssistantTaskService({
    db, externalBusy: () => padBusy() || terminal.store.busy(),
  }));
  registerCodexRoutes(server, db, options.codexProjectInspector);
  const gptLiveSessionStarter =
    options.gptLiveSessionStarter ?? gptLiveSessionStarterFromEnv();
  registerRealtimeRoute(
    server,
    options.realtimeCredentialIssuer ?? realtimeIssuerFromEnv(),
    options.geminiSessions,
    gptLiveSessionStarter,
  );
  registerGeminiRealtimeRoutes(server, options.geminiSessions);
  registerGptLiveRealtimeRoutes(server, gptLiveSessionStarter);
  registerWebRoutes(server, options.webResearcher ?? webResearcherFromEnv());
  registerReasoningRoutes(
    server,
    options.reasoningAnswerer ?? reasoningAnswererFromEnv(),
  );
  registerComputerRoutes(
    server,
    options.computerInspector,
    options.computerController,
    undefined,
    options.frontmostComputerAppReader,
    options.computerAppFocuser,
    options.computerWindowCloser,
    options.computerWindowStateSetter,
  );
  registerMessageRoutes(
    server,
    options.messageService ?? createMessageService({ db }),
  );

  server.get('/', async () => ({
    name: '@codex-lens/gateway',
    status: 'ok',
  }));

  return server;
}

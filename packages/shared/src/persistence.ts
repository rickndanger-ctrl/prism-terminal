import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  ConversationSessionSchema,
  type ConversationSession,
} from './conversation-session.js';
import {
  parseEngineeringPlan,
  type EngineeringPlan,
} from './engineering-plan.js';
import { err, ok, type Result } from './result.js';

const STORE_FILE_NAME = 'persistence.json';

const persistedStoreSchema = z
  .object({
    conversations: z.record(z.string(), z.unknown()),
    engineeringPlans: z.record(z.string(), z.unknown()),
  })
  .strict();

type PersistedStore = z.output<typeof persistedStoreSchema>;

function dataDirectory(): string {
  return process.env.CODEX_LENS_DATA_DIR || './.codex-lens-data';
}

function storePath(): string {
  return join(dataDirectory(), STORE_FILE_NAME);
}

function emptyStore(): PersistedStore {
  return { conversations: {}, engineeringPlans: {} };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function readStore(): Result<PersistedStore> {
  let contents: string;
  try {
    contents = readFileSync(storePath(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return ok(emptyStore());
    }

    return err(
      'PERSISTENCE_READ_FAILED',
      `Could not read persistence store: ${String(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return err(
      'CORRUPT_PERSISTENCE_STORE',
      'Persistence store contains malformed JSON',
    );
  }

  const parsed = persistedStoreSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      'CORRUPT_PERSISTENCE_STORE',
      `Persistence store has an invalid shape: ${formatIssues(parsed.error)}`,
    );
  }

  return ok(parsed.data);
}

function writeStore(store: PersistedStore): Result<void> {
  const directory = dataDirectory();
  const path = storePath();
  const temporaryPath = `${path}.${process.pid}.tmp`;

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
    renameSync(temporaryPath, path);
  } catch (error) {
    return err(
      'PERSISTENCE_WRITE_FAILED',
      `Could not write persistence store: ${String(error)}`,
    );
  }

  return ok(undefined);
}

export function saveConversation(session: ConversationSession): Result<void> {
  const validated = ConversationSessionSchema.safeParse(session);
  if (!validated.success) {
    return err('INVALID_CONVERSATION_SESSION', formatIssues(validated.error));
  }

  const store = readStore();
  if (!store.ok) return store;

  return writeStore({
    ...store.value,
    conversations: {
      ...store.value.conversations,
      [validated.data.conversationId]: validated.data,
    },
  });
}

export function loadConversation(id: string): Result<ConversationSession> {
  const store = readStore();
  if (!store.ok) return store;

  const persisted = store.value.conversations[id];
  if (persisted === undefined) {
    return err(
      'CONVERSATION_NOT_FOUND',
      `Conversation session "${id}" was not found`,
    );
  }

  const parsed = ConversationSessionSchema.safeParse(persisted);
  if (!parsed.success) {
    return err(
      'CORRUPT_CONVERSATION_SESSION',
      `Persisted conversation session "${id}" is invalid: ${formatIssues(parsed.error)}`,
    );
  }

  return ok(parsed.data);
}

export function saveEngineeringPlan(plan: EngineeringPlan): Result<void> {
  const validated = parseEngineeringPlan(JSON.stringify(plan));
  if (!validated.ok) return validated;

  const store = readStore();
  if (!store.ok) return store;

  return writeStore({
    ...store.value,
    engineeringPlans: {
      ...store.value.engineeringPlans,
      [validated.value.engineeringPlanId]: validated.value,
    },
  });
}

export function loadEngineeringPlan(id: string): Result<EngineeringPlan> {
  const store = readStore();
  if (!store.ok) return store;

  const persisted = store.value.engineeringPlans[id];
  if (persisted === undefined) {
    return err(
      'ENGINEERING_PLAN_NOT_FOUND',
      `Engineering plan "${id}" was not found`,
    );
  }

  return parseEngineeringPlan(JSON.stringify(persisted));
}

import { describe, expect, it, vi } from 'vitest';
import { ok } from '@codex-lens/shared';
import { openDb } from '../src/db/schema.js';
import { createSqliteAssistantTaskStore } from '../src/assistant/assistantTaskStore.js';
import { createAssistantTaskService } from '../src/assistant/assistantTasks.js';
import { VisualReferencesSchema } from '../src/assistant/visualReferences.js';
import type { AssistantTaskWorker } from '../src/assistant/codexTaskWorker.js';

const reference = { label: 'Glasses photo', jpegBase64: Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]).toString('base64') };
const instruction = 'Build a Blender model from this photo.';

describe('visual task references', () => {
  it('rejects oversized, malformed and excessive attachments', () => {
    expect(VisualReferencesSchema.safeParse([{ ...reference, jpegBase64: 'not a JPEG' }]).success).toBe(false);
    expect(VisualReferencesSchema.safeParse(Array.from({ length: 4 }, () => reference)).success).toBe(false);
    expect(VisualReferencesSchema.safeParse([{ ...reference, jpegBase64: 'A'.repeat(200_004) }]).success).toBe(false);
  });

  it('binds the reference bytes to the prepared digest', async () => {
    const digest = async (jpegBase64: string) => {
      let id = 0;
      const service = createAssistantTaskService({ id: () => `id-${++id}`, now: () => new Date('2026-11-01T12:00:00Z') });
      service.activate();
      try {
        const result = await service.prepare({ instruction, scope: 'mac', workingDirectory: '/tmp', visualReferences: [{ ...reference, jpegBase64 }] });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('preparation failed');
        return result.value.digest;
      } finally { await service.close(); }
    };
    expect(await digest(reference.jpegBase64)).not.toBe(await digest(Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]).toString('base64')));
  });

  it('preserves references through SQLite and delivers the prepared bytes to the worker', async () => {
    const db = openDb(':memory:');
    const store = createSqliteAssistantTaskStore(db);
    const worker = vi.fn<AssistantTaskWorker>(async () => ok({
      threadId: 'thread-1', turnId: 'turn-1', cancel: async () => undefined,
      completion: Promise.resolve({ state: 'completed' as const, summary: 'Test worker result' }),
    }));
    const service = createAssistantTaskService({ store, worker });
    service.activate();
    const source = { ...reference };
    try {
      const prepared = await service.prepare({ instruction, scope: 'mac', workingDirectory: '/tmp', visualReferences: [source] });
      if (!prepared.ok) throw new Error(prepared.error.code);
      source.label = 'Changed after preparation';
      const stored = store.getByTaskId(prepared.value.taskId);
      expect(stored?.visualReferences).toEqual([reference]);
      const result = await service.start({ confirmationId: prepared.value.confirmationId, digest: prepared.value.digest, authorization: prepared.value.requiresExplicitConfirmation ? 'explicit_confirmation' : 'single_utterance' });
      expect(result.ok).toBe(true);
      expect(worker.mock.calls[0]?.[0].visualReferences).toEqual([reference]);
      expect(worker.mock.calls[0]?.[0].instruction).toBe(instruction);
    } finally { await service.close(); db.close(); }
  });
});

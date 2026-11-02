import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Db } from '../db/schema.js';
import { ClefPad } from '../computer/clefPad.js';
import { focusComputerApp, closeFrontmostComputerWindow } from '../computer/codexComputer.js';
import { writeTextEditDraft } from '../computer/textEditDraft.js';
import { insertFocusedText, validFocusedText } from '../computer/focusedText.js';
import { BROWSER_ACTIONS, WINDOW_ACTIONS, executeDesktopAction, navigationURL } from '../computer/desktopActions.js';

export const PAD_APPS = ['Visual Studio Code', 'Claude', 'System Settings', 'ChatGPT', 'Cursor', 'Google Chrome', 'Safari', 'Messages', 'FaceTime', 'Notes', 'Finder', 'Calculator', 'TextEdit'] as const;
export const PadRequest = z.object({ requestId: z.string().uuid(), action: z.enum(['open', 'close', 'type', 'typeFocused', 'search', 'window', 'browser', 'navigate']),
  value: z.string().max(8000).refine(s => !s.includes('\0')).default('') }).strict().superRefine((v, ctx) => {
  if ((v.action === 'open' && !PAD_APPS.some(app => app === v.value)) ||
      (v.action === 'close' && v.value !== '') ||
      ((v.action === 'type' || v.action === 'search') && !v.value.trim()) ||
      (v.action === 'search' && v.value.length > 1000) ||
      (v.action === 'window' && !WINDOW_ACTIONS.some(action => action === v.value)) ||
      (v.action === 'browser' && !BROWSER_ACTIONS.some(action => action === v.value)) ||
      (v.action === 'navigate' && !navigationURL(v.value)) ||
      (v.action === 'typeFocused' && !validFocusedText(v.value))) ctx.addIssue({ code: 'custom', message: 'Invalid action target.' });
});
type PadInput = z.infer<typeof PadRequest>;
export async function executePad(input: PadInput): Promise<string> {
  if (input.action === 'window' || input.action === 'browser' || input.action === 'navigate') return executeDesktopAction(input.action, input.value);
  if (input.action === 'typeFocused') return insertFocusedText(input.value);
  if (input.action === 'open') {
    const r = await focusComputerApp({ app: input.value });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.app + ' is frontmost.';
  }
  if (input.action === 'close') {
    const r = await closeFrontmostComputerWindow();
    if (!r.ok) throw new Error(r.error.message);
    return r.value.closed ? 'Closed the window in ' + r.value.app + '.' : 'Window not closed. Check the Mac for a save dialog; no dialog was answered.';
  }
  if (input.action === 'type') {
    const r = await writeTextEditDraft(input.value);
    if (!r.ok) throw new Error(r.error.message);
    return 'Verified the text in a new unsaved TextEdit document. Nothing was sent.';
  }
  const url = new URL('https://www.google.com/search'); url.searchParams.set('q', input.value);
  await new Promise<void>((resolve, reject) => execFile('/usr/bin/open', [url.href],
    { shell: false, timeout: 8000, maxBuffer: 4096 }, error => error ? reject(new Error('Browser launch unverified. Do not automatically retry.')) : resolve()));
  return 'Search handed to the default browser. Page results have not been verified.';
}

export function registerCommandPadRoutes(server: FastifyInstance, db: Db, busy: () => boolean,
  execute = executePad, clef = new ClefPad()): () => boolean {
  db.exec('CREATE TABLE IF NOT EXISTS command_pad_receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL, summary TEXT)');
  let running = false;
  let runningRequestID: string | undefined;
  server.addHook('preClose', async () => clef.close());
  server.get('/v1/command-pad', async () => ({ apps: PAD_APPS, actions: ['open', 'close', 'type', 'typeFocused', 'search', 'window', 'browser', 'navigate', 'ask'], windowActions: WINDOW_ACTIONS, browserActions: BROWSER_ACTIONS }));
  // Read-only reconciliation after an interrupted HTTP response. A stored
  // summary means the executor finished reporting, not that the action worked.
  // Missing/unknown receipts never authorize an automatic retry.
  server.get('/v1/command-pad/receipts/:requestId', async (request, reply) => {
    const params = z.object({ requestId: z.string().uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: 'Invalid command receipt ID.' });
    const receipt = db.prepare('SELECT summary FROM command_pad_receipts WHERE id = ?').get(params.data.requestId) as { summary: string | null } | undefined;
    if (!receipt) return reply.code(404).send({ message: 'Command receipt not found. Do not automatically retry.' });
    return { summary: receipt.summary,
      state: receipt.summary !== null ? 'completed' : runningRequestID === params.data.requestId ? 'running' : 'unknown' };
  });
  server.post('/v1/command-pad/classify', { bodyLimit: 16384 }, async (request, reply) => {
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: 'Invalid classification request.' });
    try { return { action: await clef.classify(body.data.text), executed: false }; }
    catch { return reply.code(503).send({ message: 'Local Clef unavailable. Choose a button manually; nothing was run.' }); }
  });
  server.post('/v1/command-pad/execute', { bodyLimit: 40000 }, async (request, reply) => {
    const body = PadRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: 'Invalid command pad action.' });
    const input = body.data;
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = db.prepare('SELECT digest, summary FROM command_pad_receipts WHERE id = ?').get(input.requestId) as { digest: string; summary: string | null } | undefined;
    if (existing) {
      if (existing.digest !== digest) return reply.code(409).send({ message: 'Request ID belongs to a different action.' });
      return { summary: existing.summary ?? 'Outcome unknown or still running. Inspect the Mac; this action was not repeated.' };
    }
    if (running || busy() || db.prepare("SELECT 1 FROM assistant_tasks WHERE state = 'running' LIMIT 1").get()) return reply.code(409).send({ message: 'Mac is busy. Wait for the current task before using the pad.' });
    // Claim before any side effect. Even after restart, unknown outcomes never replay.
    db.prepare('INSERT INTO command_pad_receipts (id, digest) VALUES (?, ?)').run(input.requestId, digest);
    running = true;
    runningRequestID = input.requestId;
    try {
      const summary = await execute(input);
      db.prepare('UPDATE command_pad_receipts SET summary = ? WHERE id = ?').run(summary, input.requestId);
      return { summary };
    } catch {
      const summary = 'Action could not be verified. Inspect the Mac before trying again; no automatic retry was made.';
      db.prepare('UPDATE command_pad_receipts SET summary = ? WHERE id = ?').run(summary, input.requestId);
      return { summary };
    } finally { running = false; runningRequestID = undefined; }
  });
  return () => running;
}

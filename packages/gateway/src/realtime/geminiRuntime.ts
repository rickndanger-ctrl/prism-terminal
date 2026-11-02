import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createGeminiAttentiveSession } from './geminiAttentiveSession.js';
import { GeminiSessionPool } from './geminiSessionPool.js';
import { GeminiPhoneToolRelay } from './geminiPhoneToolRelay.js';
import type { GeminiToolBinding } from './geminiToolDispatcher.js';

async function readDedicatedKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['find-generic-password', '-s', 'com.codex-lens.gemini', '-a', 'default', '-w'],
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    const chunks: Buffer[] = []; let bytes = 0; let done = false;
    const fail = () => {
      if (done) return;
      done = true; clearTimeout(timer); child.kill();
      reject(new Error('Gemini credential unavailable'));
    };
    const timer = setTimeout(fail, 5000);
    child.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024) { fail(); return; }
      chunks.push(chunk);
    });
    child.on('close', code => {
      if (done) return;
      if (code !== 0) { fail(); return; }
      done = true; clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

/** Experimental opt-in runtime. Activation belongs after listener ownership.
 * No fallback key, eager process/provider connection, or plaintext persistence. */
export function createGeminiRuntime(options: {
  pythonExecutable: string;
  loadKey?: () => Promise<string>;
  checkPython?: (path: string) => Promise<void>;
  createSession?: typeof createGeminiAttentiveSession;
}) {
  let status: 'pending' | 'ready' | 'unavailable' | 'closed' = 'pending';
  let key: string | undefined;
  let activation: Promise<void> | undefined;
  const isClosed = () => status === 'closed';
  const pool = new GeminiSessionPool(events => {
    if (status !== 'ready' || !key) throw new Error('Gemini runtime unavailable');
    const relay = new GeminiPhoneToolRelay({ names: new Set(['get_current_time', 'research_web', 'reason_question', 'get_assistant_task_status', 'prepare_assistant_task']), timeoutMs: 45_000,
      send: message => session.sendPhoneToolMessage(message) });
    const questionArguments = z.object({ question: z.string().trim().min(2).max(1000) }).strict();
    const taskArguments = z.object({ scope: z.enum(['mac', 'project']) }).strict();
    const bindings = new Map<string, GeminiToolBinding>([
      ['get_current_time', { arguments: z.object({}).strict(), execute: (_args, signal) => relay.call('get_current_time', {}, signal) }],
      ['get_assistant_task_status', { arguments: z.object({}).strict(), execute: (_args, signal) => relay.call('get_assistant_task_status', {}, signal) }],
      ['prepare_assistant_task', { arguments: taskArguments, execute: (args, signal) => relay.call('prepare_assistant_task', taskArguments.parse(args), signal) }],
      ...['research_web', 'reason_question'].map(name => [name, {
        arguments: questionArguments,
        execute: (args: unknown, signal: AbortSignal) => relay.call(name, questionArguments.parse(args), signal),
      }] as [string, GeminiToolBinding]),
    ]);
    const session = (options.createSession ?? createGeminiAttentiveSession)({
      pythonExecutable: options.pythonExecutable,
      connection: { apiKey: key, instruction: 'You are the Codex Lens experimental voice router and speaker. Answer addressed questions briefly using tool results. Always call get_current_time for current time, date, day, or time zone. Use research_web for changing facts, news, prices, schedules, or explicit search and verify requests. Use reason_question for other informational questions, math, explanations, and planning so the configured Luna reasoning model handles them. Use get_assistant_task_status for progress or completion questions about the wearer task. For a request to operate, type, navigate, build, or edit on the Mac, call prepare_assistant_task exactly once. Its scope is project for the selected approved software repository or mac for other computer work. The phone binds the actual request; you never author task text. Ordinary tasks start through the existing Codex engine. Speak only the returned exactSpeech, or a brief factual error. Never narrate intentions before the result. If requiresExplicitConfirmation is true, nothing started: say consequential confirmation is not available in this experimental backend. Do not claim the action ran or try a different tool. Never guess after a failed call or retry an uncertain task start; use task status. No direct messaging, calendar, or camera tools are connected yet. Never claim completion or access without a tool result.',
        tools: [{ name: 'get_current_time', description: 'Read the iPhone current local date, time, and time zone. Never guess.', parameters: { type: 'OBJECT', properties: {} } },
          { name: 'prepare_assistant_task', description: 'Delegate one actual wearer request to the existing Codex Mac task engine. Supply only scope, never task text. Ordinary tasks start once; consequential tasks remain prepared. Do not retry after interruption or uncertainty. Speak the returned exactSpeech briefly.', parameters: { type: 'OBJECT', properties: { scope: { type: 'STRING', enum: ['mac', 'project'] } }, required: ['scope'] } },
          { name: 'get_assistant_task_status', description: 'Use when the wearer asks what Codex is doing, whether their task finished, or for its result. Read the phone-owned most recent task or unresolved start attempt. Do not supply a task ID. This never starts or retries work. Report its exact state and uncertainty; only completed means completed.', parameters: { type: 'OBJECT', properties: {} } },
          ...['research_web', 'reason_question'].map(name => ({ name,
            description: name === 'research_web' ? 'Research current public information and return a sourced answer. No account access or website actions.' : 'Delegate a read-only informational question to the existing Luna medium reasoning service. No computer actions.',
            parameters: { type: 'OBJECT', properties: { question: { type: 'STRING', description: 'The wearer question and relevant context, at most 1000 characters.' } }, required: ['question'] },
          })),
        ], bindings,
      },
      onAttention: result => {
        if (result.attention === 'addressed') relay.acceptSource({ turnId: result.turnId, transcript: result.transcript });
      },
      onControl: raw => {
        if (relay.handleResponse(raw)) return;
        // Host audio attention owns response approval; no data-channel bypass.
        if (Buffer.byteLength(raw) > 1024) return;
        try { if (z.object({ type: z.literal('gemini.stop') }).strict().safeParse(JSON.parse(raw)).success) { relay.close(); session.close(); } }
        catch { /* Invalid controls have no effect. */ }
      },
      onEvent: event => {
        if (event.type === 'activityStarted') relay.clearTurn();
        if (event.type === 'ready') events.ready();
        if (event.type === 'closed') { relay.close(); events.closed(); }
      },
    });
    return {
      answer: sdp => session.answer(sdp),
      close: () => { relay.close(); session.close(); },
    };
  }, { isReady: () => status === 'ready' });
  return {
    pool,
    get status() { return status; },
    activate(): Promise<void> {
      activation ??= (async () => {
        if (isClosed()) return;
        try {
          if (!isAbsolute(options.pythonExecutable)) throw new Error('Absolute Python executable required');
          await (options.checkPython ?? (path => access(path, constants.X_OK)))(options.pythonExecutable);
          if (isClosed()) return;
          const loaded = await (options.loadKey ?? readDedicatedKey)();
          if (isClosed()) return;
          if (!loaded.trim() || loaded.length > 512 || /[\r\n]/.test(loaded.trim())) throw new Error('Invalid credential');
          key = loaded.trim(); status = 'ready';
        } catch { if (!isClosed()) { key = undefined; status = 'unavailable'; } }
      })();
      return activation;
    },
    close(): void { status = 'closed'; key = undefined; pool.close(); },
  };
}

import type { Db } from '../db/schema.js';

export type TerminalState = 'disconnected' | 'ready' | 'running' | 'stopping' | 'uncertain';
export interface TerminalSession {
  id: string;
  threadId: string | null;
  title: string;
  state: TerminalState;
  turnId: string | null;
  model: string;
  updatedAt: string;
}
export interface TerminalEvent {
  sequence: number;
  kind: 'input' | 'assistant' | 'tool' | 'notice' | 'state' | 'reply';
  itemId: string;
  text?: string;
  operation?: 'append' | 'replace';
  status?: string;
  title?: string;
  imageCount?: number;
}
export type NewTerminalEvent = Omit<TerminalEvent, 'sequence'>;
export type TerminalReplyStatus = 'completed' | 'failed' | 'interrupted';
interface PendingTerminalTurn { requestId: string; sessionId: string; turnId: string | null; finalText: string; finalPhase: number }

export class TerminalStore {
  constructor(readonly db: Db) {
    db.exec([
      'CREATE TABLE IF NOT EXISTS terminal_sessions (id TEXT PRIMARY KEY, threadId TEXT, title TEXT NOT NULL, state TEXT NOT NULL, turnId TEXT, model TEXT NOT NULL, updatedAt TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS terminal_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL, body TEXT NOT NULL);',
      'CREATE INDEX IF NOT EXISTS terminal_events_session ON terminal_events(sessionId, sequence);',
      'CREATE TABLE IF NOT EXISTS terminal_requests (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, digest TEXT NOT NULL);',
      "CREATE TABLE IF NOT EXISTS terminal_turns (requestId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT, status TEXT NOT NULL, finalText TEXT NOT NULL DEFAULT '', finalPhase INTEGER NOT NULL DEFAULT 0);",
      'CREATE INDEX IF NOT EXISTS terminal_turns_session ON terminal_turns(sessionId,status);',
      'CREATE TABLE IF NOT EXISTS terminal_runtime (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER);',
    ].join('\n'));
  }
  list(): TerminalSession[] {
    return this.db.prepare('SELECT * FROM terminal_sessions ORDER BY updatedAt DESC LIMIT 50').all() as TerminalSession[];
  }
  get(id: string): TerminalSession | undefined {
    return this.db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id) as TerminalSession | undefined;
  }
  thread(id: string): TerminalSession | undefined {
    return this.db.prepare('SELECT * FROM terminal_sessions WHERE threadId = ?').get(id) as TerminalSession | undefined;
  }
  save(session: TerminalSession): TerminalSession {
    this.db.prepare('INSERT OR REPLACE INTO terminal_sessions VALUES (@id,@threadId,@title,@state,@turnId,@model,@updatedAt)').run(session);
    return session;
  }
  state(id: string, state: TerminalState, turnId: string | null = null): TerminalSession {
    const session = this.get(id);
    if (!session) throw new Error('Terminal session not found');
    return this.save({ ...session, state, turnId, updatedAt: new Date().toISOString() });
  }
  busy(): boolean {
    return this.db.prepare("SELECT 1 FROM terminal_sessions WHERE state IN ('running','stopping','uncertain') LIMIT 1").get() !== undefined;
  }
  append(id: string, event: NewTerminalEvent): TerminalEvent {
    const result = this.db.prepare('INSERT INTO terminal_events(sessionId,body) VALUES (?,?)').run(id, JSON.stringify(event));
    return { sequence: Number(result.lastInsertRowid), ...event };
  }
  events(id: string, after: number): TerminalEvent[] {
    return (this.db.prepare('SELECT sequence,body FROM terminal_events WHERE sessionId = ? AND sequence > ? ORDER BY sequence LIMIT 250').all(id, after) as { sequence: number; body: string }[])
      .map((row) => ({ ...JSON.parse(row.body) as NewTerminalEvent, sequence: row.sequence }));
  }
  /** Materialize one session once, rather than replaying every token to the phone. */
  snapshot(id: string, limit = 100) {
    const session = this.get(id);
    if (!session) throw new Error('Terminal session not found');
    const entries = new Map<string, { id: string; kind: string; text: string; title: string; status: string; imageCount: number }>();
    let cursor = 0;
    for (;;) {
      const events = this.events(id, cursor);
      for (const event of events) {
        cursor = event.sequence;
        if (!['input', 'assistant', 'tool', 'notice'].includes(event.kind)) continue;
        const entry = entries.get(event.itemId) ?? { id: event.itemId, kind: event.kind, text: '', title: '', status: '', imageCount: 0 };
        if (event.text !== undefined) entry.text = (event.operation === 'append' ? entry.text + event.text : event.text).slice(0, 64_000);
        if (event.title !== undefined) entry.title = event.title;
        if (event.status !== undefined) entry.status = event.status;
        if (event.imageCount !== undefined) entry.imageCount = event.imageCount;
        entries.set(event.itemId, entry);
      }
      if (events.length < 250) break;
    }
    const all = [...entries.values()];
    const acceptedRequestIds = (this.db.prepare('SELECT id FROM terminal_requests WHERE sessionId = ? ORDER BY rowid DESC LIMIT 100').all(id) as {id: string}[]).map((row) => row.id);
    return { entries: all.slice(-limit), cursor, state: session.state, hasEarlier: all.length > limit, acceptedRequestIds };
  }
  request(id: string): { sessionId: string; digest: string } | undefined {
    return this.db.prepare('SELECT sessionId,digest FROM terminal_requests WHERE id = ?').get(id) as { sessionId: string; digest: string } | undefined;
  }
  /** Receipts and input events are committed before dispatch and are never pruned. */
  hasCommandHistory(sessionId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM terminal_requests WHERE sessionId = ? LIMIT 1').get(sessionId)) return true;
    // Agent output also prevents replacement if a ledger is incomplete or imported.
    return this.db.prepare(
      "SELECT 1 FROM terminal_events WHERE sessionId = ? AND json_extract(body, '$.kind') IN ('input','assistant','tool') LIMIT 1",
    ).get(sessionId) !== undefined;
  }
  claim(id: string, sessionId: string, digest: string): void {
    this.db.prepare('INSERT INTO terminal_requests VALUES (?,?,?)').run(id, sessionId, digest);
  }
  beginTurn(requestId: string, sessionId: string): void {
    this.db.prepare("INSERT INTO terminal_turns(requestId,sessionId,status) VALUES (?,?,'running')").run(requestId, sessionId);
  }
  pendingTurn(sessionId: string): PendingTerminalTurn | undefined {
    return this.db.prepare("SELECT requestId,sessionId,turnId,finalText,finalPhase FROM terminal_turns WHERE sessionId = ? AND status = 'running'").get(sessionId) as PendingTerminalTurn | undefined;
  }
  bindTurn(requestId: string, turnId: string): void {
    this.db.prepare("UPDATE terminal_turns SET turnId = ? WHERE requestId = ? AND status = 'running' AND turnId IS NULL").run(turnId, requestId);
  }
  finalMessage(requestId: string, text: string, explicitFinal: boolean): void {
    this.db.prepare("UPDATE terminal_turns SET finalText = ?, finalPhase = ? WHERE requestId = ? AND status = 'running' AND (finalPhase = 0 OR ? = 1)")
      .run(text, explicitFinal ? 1 : 0, requestId, explicitFinal ? 1 : 0);
  }
  abandonTurn(sessionId: string): void {
    this.db.prepare("UPDATE terminal_turns SET status = 'uncertain' WHERE sessionId = ? AND status = 'running'").run(sessionId);
  }
  /** Final state and the request-owned reply are one durable commit, exactly once. */
  completeTurn(requestId: string, status: TerminalReplyStatus): boolean {
    return this.db.transaction(() => {
      const turn = this.db.prepare("SELECT * FROM terminal_turns WHERE requestId = ? AND status = 'running'").get(requestId) as PendingTerminalTurn | undefined;
      if (!turn) return false;
      this.db.prepare('UPDATE terminal_turns SET status = ? WHERE requestId = ?').run(status, requestId);
      this.state(turn.sessionId, 'ready');
      this.append(turn.sessionId, { kind: 'state', itemId: 'state', status: 'ready' });
      this.append(turn.sessionId, { kind: 'reply', itemId: requestId, status, text: status === 'completed' ? turn.finalText : '' });
      return true;
    })();
  }
  owner(): number | undefined {
    return (this.db.prepare('SELECT pid FROM terminal_runtime WHERE id = 1').get() as {pid: number} | undefined)?.pid;
  }
  setOwner(pid?: number): void {
    if (pid === undefined) this.db.prepare('DELETE FROM terminal_runtime').run();
    else this.db.prepare('INSERT OR REPLACE INTO terminal_runtime VALUES (1,?)').run(pid);
  }
}

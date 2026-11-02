import type { AppServerHandle } from '../codex/transport.js';

export type TaskStopIntent = 'paused' | 'cancelled';

interface ActiveRun {
  client?: AppServerHandle;
  intent?: TaskStopIntent;
}

/** Owns the live Codex process handles so HTTP controls stop actual work. */
export class TaskRunRegistry {
  private readonly runs = new Map<string, ActiveRun>();

  begin(taskId: string): void {
    this.runs.set(taskId, {});
  }

  attach(taskId: string, client: AppServerHandle): void {
    const run = this.runs.get(taskId) ?? {};
    run.client = client;
    this.runs.set(taskId, run);
    if (run.intent !== undefined) void client.close().catch(() => undefined);
  }

  intent(taskId: string): TaskStopIntent | undefined {
    return this.runs.get(taskId)?.intent;
  }

  async stop(taskId: string, intent: TaskStopIntent): Promise<boolean> {
    const run = this.runs.get(taskId);
    if (run === undefined) return false;
    run.intent = intent;
    if (run.client !== undefined) await run.client.close().catch(() => undefined);
    return true;
  }

  finish(taskId: string): void {
    this.runs.delete(taskId);
  }
}

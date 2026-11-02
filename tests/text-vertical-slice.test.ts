import { describe, expect, it } from 'vitest';

import { runTextVerticalSlice } from '../src/demo/text-vertical-slice.js';

describe('deterministic text vertical slice', () => {
  it('reaches a queued Codex task after both plan approvals', () => {
    const first = runTextVerticalSlice();
    const second = runTextVerticalSlice();

    expect(first.task.state).toBe('queued');
    expect(first.task.projectId).toBe('codex-lens-demo');
    expect(first.transcript).toEqual([
      '1. Conversation: ready for planning',
      '2. Engineering Plan: ready for approval',
      '3. Engineering approval: approved',
      '4. Execution Plan: ready for approval',
      '5. Execution approval: approved',
      '6. Codex task: queued',
    ]);
    expect(second.transcript).toEqual(first.transcript);
  });
});

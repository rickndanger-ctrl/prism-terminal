// Exercises the real isolated Codex worker. Read-only app listing only;
// no screenshots, app contents, typing, or other desktop actions are allowed.
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { createCodexAssistantTaskWorker } from '../dist/packages/gateway/src/assistant/codexTaskWorker.js';
import { startAppServer } from '../dist/packages/gateway/src/codex/transport.js';

const toolEvidence = [];
const worker = createCodexAssistantTaskWorker({
  executionTimeoutMs:60_000,
  startClient(options) {
    const client = startAppServer(options);
    client.onMessage(message => {
      const item = message.params?.item;
      if (message.method !== 'item/completed' || item?.type !== 'mcpToolCall') return;
      // Do not print or retain returned app names or usage history.
      toolEvidence.push({server:item.server,tool:item.tool,status:item.status,
        failed:Boolean(item.error || item.result?.isError),
        contentReturned:Array.isArray(item.result?.content) && item.result.content.length > 0});
    });
    return client;
  },
});
const started = await worker({
  taskId:randomUUID(), scope:'mac', authorization:'single_utterance',
  workingDirectory:process.cwd(),
  instruction:'Read-only integration test: call computer_use.list_apps exactly once. Do not use any other tool, open or inspect an app, capture a screen, or change anything. If it succeeds, report only that the native tool returned an app inventory; do not repeat app names or usage history. If it fails, report the exact failure and stop without fallback.',
});
if (!started.ok) {
  console.log(JSON.stringify({state:'failed',code:started.error.code}));
  process.exitCode = 1;
} else {
  try {
    const result = await started.value.completion;
    const verified = toolEvidence.length === 1 && toolEvidence[0].server === 'computer_use'
      && toolEvidence[0].tool === 'list_apps' && !toolEvidence[0].failed && toolEvidence[0].contentReturned;
    console.log(JSON.stringify({...result,verified,toolEvidence}));
    if (result.state !== 'completed' || !verified) process.exitCode = 1;
  } finally { await started.value.close?.(); }
}

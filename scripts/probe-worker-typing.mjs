// Opt-in live desktop test. The operator opens a disposable fixture in
// TextEdit first. Two independent Lens workers edit/save only that file.
import process from 'node:process';
import console from 'node:console';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCodexAssistantTaskWorker } from '../dist/packages/gateway/src/assistant/codexTaskWorker.js';
import { startAppServer } from '../dist/packages/gateway/src/codex/transport.js';

const fixture = realpathSync(process.argv[2] || '');
if (basename(fixture) !== 'lens-acceptance.txt' || !/^\/private\/tmp\/codex-lens-typing\.[A-Za-z0-9]+$/.test(dirname(fixture))) {
  throw new Error('Use an explicitly prepared /tmp/codex-lens-typing.XXXXXX/lens-acceptance.txt fixture.');
}
const baseline = 'Codex Lens typing acceptance.\n';
if (readFileSync(fixture, 'utf8') !== baseline) throw new Error('Fixture is not pristine; refusing to overwrite unrelated content.');
let expected = baseline;
for (const line of ['First hands-free edit verified.', 'Second independent follow-up edit verified.']) {
  const calls = [];
  let nonNativeAction = false;
  const worker = createCodexAssistantTaskWorker({executionTimeoutMs:120_000,
    startClient(options) {
      const client = startAppServer(options);
      const send = client.send.bind(client);
      const preflightIDs = new Set();
      client.send = async message => {
        if (message.method === 'mcpServerStatus/list') preflightIDs.add(message.id);
        return send(message);
      };
      client.onMessage(message => {
        if (preflightIDs.delete(message.id)) {
          console.log(JSON.stringify({phase:'preflight',servers:message.result?.data?.map(server => ({name:server.name,tools:Object.keys(server.tools ?? {})}))}));
        }
        const item = message.params?.item;
        if (message.method !== 'item/completed' || !item) return;
        if (['commandExecution', 'fileChange'].includes(item.type)) nonNativeAction = true;
        if (item.type === 'mcpToolCall') {
          calls.push({server:item.server,tool:item.tool,failed:Boolean(item.error || item.result?.isError)});
          if (item.server !== 'computer_use') nonNativeAction = true;
        }
      });
      return client;
    },
  });
  const startedAt = performance.now();
  const started = await worker({taskId:randomUUID(),scope:'mac',authorization:'single_utterance',workingDirectory:process.cwd(),
    instruction:`Use only the native computer_use MCP to edit the already-open TextEdit document lens-acceptance.txt. The operator has verified that its path is ${fixture}. First get fresh TextEdit state and verify the document title and exact existing text match ${JSON.stringify(expected)}. If a document URL is exposed, also check that it matches the path. If the title or text do not match, stop blocked without changing anything. Append this exact line followed by one newline: ${JSON.stringify(line)}. Preserve all existing text and add no extra blank line. Save using TextEdit and verify the visible result. Tool discovery is allowed. Do not open or inspect any other document or app, use a shell, directly edit a file, send anything, or use fallback tools. This is a disposable local acceptance fixture.`,
  });
  if (!started.ok) throw new Error(started.error.code);
  let result;
  try { result = await started.value.completion; }
  finally { await started.value.close?.(); }
  expected += line+'\n';
  const verified = result.state === 'completed' && readFileSync(fixture, 'utf8') === expected
    && !nonNativeAction && calls.some(call => call.tool === 'get_app_state')
    && calls.some(call => ['type_text','set_value'].includes(call.tool) && !call.failed);
  console.log(JSON.stringify({state:result.state,verified,elapsedSeconds:Number(((performance.now()-startedAt)/1000).toFixed(2)),calls,summary:result.summary}));
  if (!verified) { process.exitCode = 1; break; }
}

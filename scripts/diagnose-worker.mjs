// Read-only: starts the exact isolated worker and lists MCP tools. No model
// turn, desktop inspection, screenshot, or tool execution is performed.
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { createIsolatedCodexRuntime } from '../dist/packages/gateway/src/assistant/isolatedCodexRuntime.js';
import { startAppServer } from '../dist/packages/gateway/src/codex/transport.js';
import { initialize } from '../dist/packages/gateway/src/codex/client.js';
import { resolveCodexExecutable } from '../dist/packages/gateway/src/codex/executable.js';

const runtime = createIsolatedCodexRuntime({ capabilitySet: 'mac' });
const client = startAppServer({
  command: resolveCodexExecutable(),
  args: ['app-server', '--strict-config'], cwd: process.cwd(), env: runtime.env,
});
try {
  const initialized = await initialize(client);
  if (!initialized.ok) throw new Error(initialized.error.code);
  runtime.sealCredentials?.();
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('MCP_STATUS_TIMEOUT')); }, 30000);
    const unsubscribe = client.onMessage(message => {
      if (message.id !== 'lens-mcp-diagnostic') return;
      clearTimeout(timer); unsubscribe();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    client.send({id:'lens-mcp-diagnostic', method:'mcpServerStatus/list', params:{limit:100}}).catch(reject);
  });
  console.log(JSON.stringify(result, (key, value) => {
    if (key === 'description' && !process.argv.includes('--include-docs')) return undefined;
    if ((key === 'inputSchema' || key === 'outputSchema') && !process.argv.includes('--include-schema')) return undefined;
    if (key === 'annotations') return undefined;
    return value;
  }, 2));
} finally {
  await client.close();
  runtime.cleanup();
}

import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const gatewayEntry = fileURLToPath(
  new URL('../../../dist/packages/gateway/src/index.js', import.meta.url),
);
const sharedPackage = fileURLToPath(
  new URL(
    '../../../dist/node_modules/@codex-lens/shared/package.json',
    import.meta.url,
  ),
);

test('the emitted gateway loads emitted workspace packages', async () => {
  rmSync(new URL('../../../dist', import.meta.url), {
    recursive: true,
    force: true,
  });

  const build = spawn('npm', ['run', 'build', '--silent'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const buildExitCode = await new Promise<number | null>((resolve, reject) => {
    build.once('error', reject);
    build.once('close', resolve);
  });

  expect(buildExitCode).toBe(0);
  expect(JSON.parse(readFileSync(sharedPackage, 'utf8'))).toMatchObject({
    name: '@codex-lens/shared',
    exports: './index.js',
  });

  const gateway = spawn(process.execPath, [gatewayEntry], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_LENS_PORT: '0' },
  });
  let output = '';

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      gateway.kill();
      reject(new Error(`gateway did not start:\n${output}`));
    }, 5_000);

    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Codex Lens gateway started')) {
        clearTimeout(timeout);
        gateway.kill();
      }
    };

    gateway.stdout.on('data', capture);
    gateway.stderr.on('data', capture);
    gateway.once('error', reject);
    gateway.once('close', (code, signal) => {
      clearTimeout(timeout);
      const started = output.includes('Codex Lens gateway started')
        && (signal === 'SIGTERM' || code === 0);
      const sandboxBlockedListen =
        code === 1 && output.includes('listen EPERM: operation not permitted');
      if (started || sandboxBlockedListen) {
        resolve();
        return;
      }
      reject(new Error(`gateway exited (${code ?? signal}):\n${output}`));
    });
  });

  expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
}, 30_000);

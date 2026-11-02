import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repositoryDirectory = new URL('../', import.meta.url);
await mkdir(new URL('../dist/native/', import.meta.url), { recursive: true });
execFileSync('/usr/bin/swiftc', ['native/FocusedText.swift', '-o', 'dist/native/focused-text'], {
  cwd: repositoryDirectory, stdio: 'inherit',
});
// Explicit non-secret bridge assets only; never copy a virtualenv or local data.
const pythonDirectory = new URL('../dist/packages/gateway/python/', import.meta.url);
await mkdir(pythonDirectory, { recursive: true });
await Promise.all(['gemini_bridge_process.py', 'gemini_webrtc_bridge.py', 'gemini_speech_boundaries.py', 'requirements.txt']
  .map(name => copyFile(new URL(`../packages/gateway/python/${name}`, import.meta.url), new URL(name, pythonDirectory))));
let buildIdentity = 'unversioned';
try {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const changes = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', '.', ':!output'],
    { cwd: repositoryDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  if (/^[a-f0-9]{40}$/.test(revision)) {
    buildIdentity = `${revision}${changes ? '.dirty' : ''}`;
  }
} catch {
  // Source archives remain buildable, but cannot claim Git provenance.
}

await writeFile(
  new URL('../dist/packages/gateway/src/buildIdentity.js', import.meta.url),
  `export const GATEWAY_BUILD_IDENTITY = ${JSON.stringify(buildIdentity)};\n`,
);

const sharedPackageDirectory = new URL(
  '../dist/node_modules/@codex-lens/shared/',
  import.meta.url,
);

await mkdir(sharedPackageDirectory, { recursive: true });
await Promise.all([
  writeFile(
    new URL('package.json', sharedPackageDirectory),
    `${JSON.stringify(
      {
        name: '@codex-lens/shared',
        private: true,
        type: 'module',
        exports: './index.js',
      },
      null,
      2,
    )}\n`,
  ),
  writeFile(
    new URL('index.js', sharedPackageDirectory),
    "export * from '../../../packages/shared/src/index.js';\n",
  ),
]);

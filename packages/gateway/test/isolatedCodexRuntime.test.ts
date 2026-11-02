import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIsolatedCodexRuntime } from '../src/assistant/isolatedCodexRuntime.js';
import { resolveCodexExecutable } from '../src/codex/executable.js';

const roots: string[] = [];

function directory(...parts: string[]): string {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function fixture(): {
  root: string;
  sourceCodexHome: string;
  nodeReplCommand: string;
  clawdCursorCommand: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'codex-lens-runtime-test-'));
  roots.push(root);
  const sourceCodexHome = directory(root, 'source-codex');
  writeFileSync(join(sourceCodexHome, 'auth.json'), '{"test":true}', { mode: 0o600 });
  const nodeReplCommand = join(root, 'node_repl');
  const clawdCursorCommand = join(root, 'clawdcursor');
  writeFileSync(nodeReplCommand, 'fixture');
  writeFileSync(clawdCursorCommand, 'fixture');

  const bundled = directory(sourceCodexHome, 'plugins', 'cache', 'openai-bundled');
  for (const [plugin, skill] of [
    ['computer-use', 'computer-use'],
    ['browser', 'control-in-app-browser'],
    ['chrome', 'control-chrome'],
  ] as const) {
    const skillDirectory = directory(bundled, plugin, '1.0.0', 'skills', skill);
    writeFileSync(join(skillDirectory, 'SKILL.md'), `# ${skill}\n`);
  }
  const clawdSkill = directory(sourceCodexHome, 'skills', 'clawdcursor');
  writeFileSync(join(clawdSkill, 'SKILL.md'), '# Clawd Cursor\n');

  return { root, sourceCodexHome, nodeReplCommand, clawdCursorCommand };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('isolated Codex task runtime', () => {
  it('preserves terminal history, refreshes managed skill links, and seals copied credentials across restarts', () => {
    const item = fixture();
    const persistentDirectory = join(item.root, 'terminal');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const runtime = createIsolatedCodexRuntime({ ...item, persistentDirectory });
      expect(existsSync(join(persistentDirectory, 'auth.json'))).toBe(true);
      if (attempt === 0) writeFileSync(join(persistentDirectory, 'history.jsonl'), 'test-history');
      runtime.sealCredentials?.();
      runtime.cleanup();
      expect(existsSync(join(persistentDirectory, 'auth.json'))).toBe(false);
      expect(readFileSync(join(persistentDirectory, 'history.jsonl'), 'utf8')).toBe('test-history');
      expect(existsSync(join(item.sourceCodexHome, 'auth.json'))).toBe(true);
    }
  });

  it('exposes native Computer Use without depending on retired skill files', () => {
    const item = fixture();
    directory(item.sourceCodexHome, 'computer-use', 'Codex Computer Use.app');
    writeFileSync(join(item.sourceCodexHome, 'computer-use', 'private-state.json'), '{}');
    const computerUseCommand = join(item.root, 'native-computer-client');
    writeFileSync(computerUseCommand, 'fixture');
    const runtime = createIsolatedCodexRuntime({ ...item, computerUseCommand });
    try {
      const config = readFileSync(join(runtime.codexHome, 'config.toml'), 'utf8');
      expect(config).toContain('[mcp_servers.computer_use]');
      expect(runtime.requiredMcpServers).toEqual(['computer_use']);
      expect(config).toContain(`command = ${JSON.stringify(computerUseCommand)}`);
      expect(config).toContain('args = ["mcp"]');
      expect(config).toContain(`[mcp_servers.computer_use.env]\nCODEX_HOME = ${JSON.stringify(item.sourceCodexHome)}`);
      expect(runtime.env.CODEX_HOME).toBe(runtime.codexHome);
      expect(existsSync(join(runtime.codexHome, 'computer-use'))).toBe(false);
    } finally { runtime.cleanup(); }
  });

  it('does not expose native Computer Use in project scope or when missing', () => {
    const item = fixture();
    directory(item.sourceCodexHome, 'computer-use', 'Codex Computer Use.app');
    for (const capabilitySet of ['project', 'mac'] as const) {
      const computerUseCommand = join(item.root, capabilitySet === 'project' ? 'native-client' : 'missing-client');
      if (capabilitySet === 'project') writeFileSync(computerUseCommand, 'fixture');
      const runtime = createIsolatedCodexRuntime({ ...item, capabilitySet, computerUseCommand });
      try {
        expect(readFileSync(join(runtime.codexHome, 'config.toml'), 'utf8')).not.toContain('[mcp_servers.computer_use]');
        expect(runtime.requiredMcpServers).toEqual([]);
        if (capabilitySet === 'project') expect(existsSync(join(runtime.codexHome, 'computer-use'))).toBe(false);
      } finally { runtime.cleanup(); }
    }
  });

  it('copies no user-global connectors and exposes only audited task MCPs', () => {
    const item = fixture();
    const runtime = createIsolatedCodexRuntime({
      sourceCodexHome: item.sourceCodexHome,
      temporaryRoot: item.root,
      baseEnv: {
        PATH: '/usr/bin',
        CODEX_HOME: '/hostile/global/codex-home',
        CODEX_SQLITE_HOME: '/hostile/global/sqlite-home',
        OPENAI_API_KEY: 'must-not-reach-worker',
        CODEX_LENS_GATEWAY_TOKEN: 'must-not-reach-worker',
        ORDINARY_SETTING: 'retained',
      },
      nodeReplCommand: item.nodeReplCommand,
      clawdCursorCommand: item.clawdCursorCommand,
    });

    expect(runtime.env.CODEX_HOME).toBe(runtime.codexHome);
    expect(runtime.env.CODEX_SQLITE_HOME).toBe(runtime.codexHome);
    expect(runtime.env.PATH).toBe('/usr/bin');
    expect(runtime.env.ORDINARY_SETTING).toBe('retained');
    expect(runtime.env.OPENAI_API_KEY).toBeUndefined();
    expect(runtime.env.CODEX_LENS_GATEWAY_TOKEN).toBeUndefined();
    expect(readFileSync(join(runtime.codexHome, 'auth.json'), 'utf8')).toBe('{"test":true}');
    writeFileSync(join(runtime.codexHome, 'auth.json'), '{"ephemeral":true}');
    expect(readFileSync(join(item.sourceCodexHome, 'auth.json'), 'utf8')).toBe('{"test":true}');

    const config = readFileSync(join(runtime.codexHome, 'config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.node_repl]');
    expect(config).toContain('[mcp_servers.clawdcursor]');
    expect(config).toContain('hooks = false');
    expect(config).toContain('project_doc_max_bytes = 0');
    expect(config).toContain('project_doc_fallback_filenames = []');
    expect(config).toContain(`sqlite_home = ${JSON.stringify(runtime.codexHome)}`);
    expect(config).toContain('[skills.bundled]\nenabled = false');
    expect(config).toContain('apps = false');
    expect(config).toContain('auth_elicitation = false');
    expect(config).toContain('image_generation = false');
    expect(config).toContain('plugins = false');
    expect(config).toContain('memories = false');
    expect(config).toContain('skill_mcp_dependency_install = false');
    expect(config).toContain('tool_call_mcp_elicitation = false');
    expect(config).toContain('inherit = "core"');
    expect(config).toContain('ignore_default_excludes = false');
    expect(config).toContain('CODEX_HOME = "exclude"');
    expect(config).toContain(`CODEX_HOME = ${JSON.stringify(runtime.codexHome)}`);
    expect(config).not.toContain('messages');
    expect(config).not.toContain('sticky');
    expect(config).not.toContain('computer-history');

    for (const skill of [
      'computer-use',
      'control-in-app-browser',
      'control-chrome',
      'clawdcursor',
    ]) {
      expect(existsSync(join(runtime.codexHome, 'skills', skill, 'SKILL.md'))).toBe(true);
    }

    runtime.sealCredentials?.();
    expect(existsSync(join(runtime.codexHome, 'auth.json'))).toBe(false);
    runtime.sealCredentials?.();

    runtime.cleanup();
    expect(existsSync(runtime.codexHome)).toBe(false);
    runtime.cleanup();
  });

  it('omits unavailable MCP commands instead of inheriting alternatives', () => {
    const item = fixture();
    const runtime = createIsolatedCodexRuntime({
      sourceCodexHome: item.sourceCodexHome,
      temporaryRoot: item.root,
      nodeReplCommand: join(item.root, 'missing-node-repl'),
      clawdCursorCommand: join(item.root, 'missing-clawd'),
    });

    const config = readFileSync(join(runtime.codexHome, 'config.toml'), 'utf8');
    expect(config).not.toContain('[mcp_servers.');
    runtime.cleanup();
  });

  it('exposes no privileged MCPs or computer-control skills to project tasks', () => {
    const item = fixture();
    const runtime = createIsolatedCodexRuntime({
      capabilitySet: 'project',
      sourceCodexHome: item.sourceCodexHome,
      temporaryRoot: item.root,
      nodeReplCommand: item.nodeReplCommand,
      clawdCursorCommand: item.clawdCursorCommand,
      projectRoot: '/workspace/project',
      allowedCommands: [
        'npm test',
        'git push origin main',
        'npm install',
        'npm run deploy',
        './release.sh',
        'bash -lc ./administrator-reviewed-wrapper',
      ],
    });

    const config = readFileSync(join(runtime.codexHome, 'config.toml'), 'utf8');
    expect(config).not.toContain('[mcp_servers.');
    expect(config).toContain('hooks = true');
    expect(config).toContain('apps = false');
    expect(config).toContain('plugins = false');
    expect(config).toContain('memories = false');
    expect(config).toContain('computer_use = false');
    expect(config).toContain('browser_use_full_cdp_access = false');
    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain('multi_agent = false');
    expect(config).toContain('[projects."/workspace/project"]');
    expect(config).toContain('trust_level = "untrusted"');
    expect(config).toContain('[[hooks.PreToolUse]]');
    expect(readdirSync(join(runtime.codexHome, 'skills'))).toEqual([]);

    const hook = join(runtime.codexHome, 'project-command-policy.mjs');
    const allowed = spawnSync(process.execPath, [hook], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command: 'npm test' } }),
    });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');

    const trustedWrapper = spawnSync(process.execPath, [hook], {
      encoding: 'utf8',
      input: JSON.stringify({
        tool_input: { command: 'bash -lc ./administrator-reviewed-wrapper' },
      }),
    });
    expect(trustedWrapper.status).toBe(0);
    expect(trustedWrapper.stdout).toBe('');

    for (const command of [
      'git push origin main',
      'npm install',
      'npm run deploy',
      './release.sh',
      'npm test && git push',
    ]) {
      const hardBlocked = spawnSync(process.execPath, [hook], {
        encoding: 'utf8',
        input: JSON.stringify({ tool_input: { command } }),
      });
      expect(hardBlocked.status, command).toBe(0);
      expect(JSON.parse(hardBlocked.stdout), command).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('project scope'),
        },
      });
    }

    const denied = spawnSync(process.execPath, [hook], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command: 'npm test && git push' } }),
    });
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    runtime.cleanup();
  });

  it('passes the installed Codex strict-config parser for both capability sets', () => {
    const binary = resolveCodexExecutable();
    if (!existsSync(binary)) return;
    for (const capabilitySet of ['project', 'mac'] as const) {
      const item = fixture();
      const runtime = createIsolatedCodexRuntime({
        capabilitySet,
        sourceCodexHome: item.sourceCodexHome,
        temporaryRoot: item.root,
        nodeReplCommand: item.nodeReplCommand,
        clawdCursorCommand: item.clawdCursorCommand,
        ...(capabilitySet === 'project'
          ? { projectRoot: '/workspace/project', allowedCommands: ['npm test'] }
          : {}),
      });
      const parsed = spawnSync(binary, ['app-server', '--strict-config', '--stdio'], {
        encoding: 'utf8',
        env: runtime.env,
        input: '',
      });
      expect(parsed.status, `${capabilitySet}: ${parsed.stderr}`).toBe(0);
      runtime.cleanup();
    }
  });
});

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexExecutable } from '../codex/executable.js';

export interface IsolatedCodexRuntime {
  codexHome: string;
  env: NodeJS.ProcessEnv;
  requiredMcpServers?: readonly string[];
  /** Remove the bootstrap credential file after Codex has loaded it. */
  sealCredentials?(): void;
  cleanup(): void;
}

export interface IsolatedCodexRuntimeOptions {
  capabilitySet?: 'project' | 'mac';
  projectRoot?: string;
  allowedCommands?: readonly string[];
  sourceCodexHome?: string;
  temporaryRoot?: string;
  /** Host-owned history directory. Cleanup seals credentials but preserves conversations. */
  persistentDirectory?: string;
  baseEnv?: NodeJS.ProcessEnv;
  nodeReplCommand?: string;
  computerUseCommand?: string;
  clawdCursorCommand?: string;
  nodeCommand?: string;
}

const CHATGPT_RESOURCES = '/Applications/ChatGPT.app/Contents/Resources';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function latestVersionDirectory(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((entry) => join(root, entry))
    .find((candidate) => existsSync(candidate));
}

function linkSkill(skillsDirectory: string, name: string, source: string | undefined): void {
  if (source === undefined || !existsSync(join(source, 'SKILL.md'))) return;
  const destination = join(skillsDirectory, name);
  try {
    if (!lstatSync(destination).isSymbolicLink()) throw new Error('Expected a managed skill link');
    rmSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  symlinkSync(source, destination);
}

function runtimeConfig(options: {
  capabilitySet: 'project' | 'mac';
  sourceCodexHome: string;
  runtimeCodexHome: string;
  nodeReplCommand: string;
  computerUseCommand: string;
  clawdCursorCommand: string;
  projectRoot?: string;
  commandPolicyHook?: string;
}): string {
  const nodeModules = join(CHATGPT_RESOURCES, 'cua_node', 'lib', 'node_modules');
  const nodeBinary = join(CHATGPT_RESOURCES, 'cua_node', 'bin', 'node');
  const computerUseApp = join(
    options.sourceCodexHome,
    'computer-use',
    'Codex Computer Use.app',
  );
  const browserVersion = latestVersionDirectory(join(
    options.sourceCodexHome,
    'plugins',
    'cache',
    'openai-bundled',
    'browser',
  ));
  const browserService = browserVersion === undefined
    ? ''
    : join(browserVersion, 'scripts', 'browser-service.mjs');
  const trustedPaths = [nodeModules, ...(browserService === '' ? [] : [browserService])]
    .join(':');
  const trustedServices = JSON.stringify({
    ...(browserService === '' ? {} : { browser: browserService }),
    sky: '@oai/sky/service',
  });

  const sections = [
    '# Generated for one Codex Lens task. Do not add user-global connectors here.',
    '# Repository instruction files are untrusted task data and are never loaded.',
    'project_doc_max_bytes = 0',
    'project_doc_fallback_filenames = []',
    `sqlite_home = ${tomlString(options.runtimeCodexHome)}`,
    ...(options.capabilitySet === 'project' ? ['web_search = "disabled"'] : []),
    '',
    '[skills.bundled]',
    'enabled = false',
    '',
    '[features]',
    '# Only the gateway-generated project command policy hook may run.',
    `hooks = ${options.capabilitySet === 'project' ? 'true' : 'false'}`,
    '# User-global apps, plugins, and memories are never inherited by a task worker.',
    'apps = false',
    'auth_elicitation = false',
    'goals = false',
    'image_generation = false',
    'plugins = false',
    'plugin_sharing = false',
    'memories = false',
    'recommended_plugins = false',
    'request_permissions_tool = false',
    'skill_mcp_dependency_install = false',
    'tool_call_mcp_elicitation = false',
    'tool_suggest = false',
    ...(options.capabilitySet === 'project'
      ? [
          'browser_use = false',
          'browser_use_external = false',
          'browser_use_full_cdp_access = false',
          'computer_use = false',
          'in_app_browser = false',
          'multi_agent = false',
          'multi_agent_v2 = false',
          'remote_plugin = false',
          'skill_search = false',
          'workspace_dependencies = false',
        ]
      : []),
    '',
    '[shell_environment_policy]',
    '# Tool subprocesses receive only ordinary core variables, never gateway or API credentials.',
    'inherit = "core"',
    'ignore_default_excludes = false',
    'experimental_use_profile = false',
    '',
    '[shell_environment_policy.filters]',
    'CODEX_HOME = "exclude"',
  ];

  if (options.capabilitySet === 'project' && options.projectRoot !== undefined) {
    sections.push(
      '',
      `[projects.${tomlString(options.projectRoot)}]`,
      '# Never load or trust hooks/config supplied by the repository being operated on.',
      'trust_level = "untrusted"',
    );
  }

  if (options.capabilitySet === 'project' && options.commandPolicyHook !== undefined) {
    sections.push(
      '',
      '[[hooks.PreToolUse]]',
      'matcher = "^Bash$"',
      '',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      `command = ${tomlString(options.commandPolicyHook)}`,
      'timeout = 5',
      'statusMessage = "Checking the project command allowlist"',
    );
  }

  // Current Computer Use bundles expose self-describing MCP tools and may
  // ship no legacy SKILL.md. Do not rely on a missing skill to teach a generic
  // JavaScript REPL how to bootstrap native desktop control.
  if (options.capabilitySet === 'mac' && existsSync(options.computerUseCommand)) {
    sections.push(
      '',
      '[mcp_servers.computer_use]',
      `command = ${tomlString(options.computerUseCommand)}`,
      'args = ["mcp"]',
      'startup_timeout_sec = 30',
      '',
      '[mcp_servers.computer_use.env]',
      // The signed native service needs its existing runtime/IPC directory.
      // Only this explicitly configured MCP receives that location; the Codex
      // worker and its shell keep the isolated home and no global connectors.
      `CODEX_HOME = ${tomlString(options.sourceCodexHome)}`,
    );
  }

  if (options.capabilitySet === 'mac' && existsSync(options.nodeReplCommand)) {
    sections.push(
      '',
      '[mcp_servers.node_repl]',
      `command = ${tomlString(options.nodeReplCommand)}`,
      'args = []',
      'startup_timeout_sec = 120',
      '',
      '[mcp_servers.node_repl.env]',
      'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"',
      `NODE_REPL_NODE_MODULE_DIRS = ${tomlString(nodeModules)}`,
      `NODE_REPL_NODE_PATH = ${tomlString(nodeBinary)}`,
      `NODE_REPL_TRUSTED_CODE_PATHS = ${tomlString(trustedPaths)}`,
      `CODEX_HOME = ${tomlString(options.runtimeCodexHome)}`,
      'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
      'BROWSER_USE_TINYSKY_ENABLED = "0"',
      'NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER = "Control the in-app browser only when the exact task requires it."',
      'NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME = "Control Chrome only when the exact task requires existing signed-in browser state."',
      'NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE = "Control desktop apps on macOS only for the exact confirmed task."',
      'BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod"',
      `NODE_REPL_TRUSTED_SERVICES = ${tomlString(trustedServices)}`,
      `SKY_CUA_SERVICE_PATH = ${tomlString(computerUseApp)}`,
      `CODEX_CLI_PATH = ${tomlString(resolveCodexExecutable())}`,
    );
  }

  if (options.capabilitySet === 'mac' && existsSync(options.clawdCursorCommand)) {
    sections.push(
      '',
      '[mcp_servers.clawdcursor]',
      `command = ${tomlString(options.clawdCursorCommand)}`,
      'args = ["mcp", "--compact"]',
      'startup_timeout_sec = 120',
    );
  }

  return `${sections.join('\n')}\n`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandPolicySource(allowedCommands: readonly string[]): string {
  return `const allowed = new Set(${JSON.stringify(allowedCommands.map((command) => command.trim()))});
const packageActions = new Set(['install', 'i', 'add', 'update', 'upgrade', 'publish']);
const deployActions = new Set(['deploy', 'release', 'publish']);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1_000_000) process.exit(2);
});
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { payload = undefined; }
  const command = payload?.tool_input?.command;
  const normalized = typeof command === 'string' ? command.trim() : '';
  const segments = normalized.split(/(?:&&|\\|\\||[;|\\n])/u).map((part) => part.trim());
  const hardBlocked = segments.some((segment) => {
    const words = segment.split(/\\s+/u).filter(Boolean);
    if (words[0] === 'sudo') words.shift();
    const executable = (words[0] ?? '').split('/').at(-1) ?? '';
    const args = words.slice(1);
    if (executable === 'git' && args.some((word) => word === 'commit' || word === 'push')) return true;
    if (['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'brew', 'gem', 'bundle'].includes(executable)) {
      const actionIndex = args.findIndex((word) => !word.startsWith('-'));
      const action = actionIndex < 0 ? '' : args[actionIndex];
      const script = action === 'run' ? args[actionIndex + 1] ?? '' : action;
      if (packageActions.has(action) || deployActions.has(script)) return true;
    }
    if (['vercel', 'netlify', 'fly', 'flyctl'].includes(executable) && args.some((word) => deployActions.has(word))) return true;
    if (['make', 'just'].includes(executable) && args.some((word) => deployActions.has(word))) return true;
    return /^(?:deploy|release|publish)(?:\\.sh)?$/u.test(executable);
  });
  const deny = (reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    }));
  };
  if (hardBlocked) {
    deny('Command blocked: project scope cannot install, commit, push, publish, release, or deploy.');
    return;
  }
  if (normalized !== '' && allowed.has(normalized)) process.exit(0);
  deny('Command blocked: it is not an exact approved project command.');
});
`;
}

/**
 * Build an ephemeral Codex home containing only the task worker's audited MCP
 * servers and skills. Authentication is copied only long enough for app-server
 * startup and then removed before the task turn; user-global MCPs, memories,
 * history, apps, and plugins are not copied into the worker runtime.
 */
export function createIsolatedCodexRuntime(
  options: IsolatedCodexRuntimeOptions = {},
): IsolatedCodexRuntime {
  const sourceCodexHome = options.sourceCodexHome ?? join(homedir(), '.codex');
  const capabilitySet = options.capabilitySet ?? 'mac';
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const nodeReplCommand = options.nodeReplCommand
    ?? join(CHATGPT_RESOURCES, 'cua_node', 'bin', 'node_repl');
  const computerUseCommand = options.computerUseCommand ?? join(
    sourceCodexHome, 'computer-use', 'Codex Computer Use.app', 'Contents',
    'SharedSupport', 'SkyComputerUseClient.app', 'Contents', 'MacOS', 'SkyComputerUseClient',
  );
  const clawdCursorCommand = options.clawdCursorCommand
    ?? join(homedir(), '.local', 'bin', 'clawdcursor');
  const nodeCommand = options.nodeCommand ?? process.execPath;
  const codexHome = options.persistentDirectory ?? mkdtempSync(join(temporaryRoot, 'codex-lens-task-'));
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  try {
    const sourceAuth = join(sourceCodexHome, 'auth.json');
    if (existsSync(sourceAuth)) {
      // Copy credentials into the disposable runtime. A symlink would let a
      // broad Mac task overwrite the user's real Codex authentication file.
      copyFileSync(sourceAuth, join(codexHome, 'auth.json'));
    }

    const skillsDirectory = join(codexHome, 'skills');
    mkdirSync(skillsDirectory, { recursive: true });
    if (capabilitySet === 'mac') {
      const bundledRoot = join(sourceCodexHome, 'plugins', 'cache', 'openai-bundled');
      const computerUseVersion = latestVersionDirectory(join(bundledRoot, 'computer-use'));
      const browserVersion = latestVersionDirectory(join(bundledRoot, 'browser'));
      const chromeVersion = latestVersionDirectory(join(bundledRoot, 'chrome'));
      linkSkill(
        skillsDirectory,
        'computer-use',
        computerUseVersion === undefined
          ? undefined
          : join(computerUseVersion, 'skills', 'computer-use'),
      );
      linkSkill(
        skillsDirectory,
        'control-in-app-browser',
        browserVersion === undefined
          ? undefined
          : join(browserVersion, 'skills', 'control-in-app-browser'),
      );
      linkSkill(
        skillsDirectory,
        'control-chrome',
        chromeVersion === undefined
          ? undefined
          : join(chromeVersion, 'skills', 'control-chrome'),
      );
      linkSkill(skillsDirectory, 'clawdcursor', join(sourceCodexHome, 'skills', 'clawdcursor'));
    }

    let commandPolicyHook: string | undefined;
    if (capabilitySet === 'project') {
      const hookPath = join(codexHome, 'project-command-policy.mjs');
      writeFileSync(
        hookPath,
        commandPolicySource(options.allowedCommands ?? []),
        { encoding: 'utf8', mode: 0o500 },
      );
      commandPolicyHook = `${shellSingleQuote(nodeCommand)} ${shellSingleQuote(hookPath)}`;
    }

    writeFileSync(
      join(codexHome, 'config.toml'),
      runtimeConfig({
        capabilitySet,
        sourceCodexHome,
        runtimeCodexHome: codexHome,
        nodeReplCommand,
        computerUseCommand,
        clawdCursorCommand,
        projectRoot: options.projectRoot,
        commandPolicyHook,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (error) {
    if (options.persistentDirectory === undefined) rmSync(codexHome, { recursive: true, force: true });
    else rmSync(join(codexHome, 'auth.json'), { force: true });
    throw error;
  }

  let cleaned = false;
  let credentialsSealed = false;
  return {
    codexHome,
    requiredMcpServers: capabilitySet === 'mac' && existsSync(computerUseCommand)
      ? ['computer_use'] : [],
    env: sanitizedWorkerEnvironment(options.baseEnv ?? process.env, codexHome),
    sealCredentials() {
      if (credentialsSealed) return;
      credentialsSealed = true;
      rmSync(join(codexHome, 'auth.json'), { force: true });
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (options.persistentDirectory === undefined) rmSync(codexHome, { recursive: true, force: true });
      else rmSync(join(codexHome, 'auth.json'), { force: true });
    },
  };
}

function sanitizedWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name === 'CODEX_HOME' || name === 'CODEX_SQLITE_HOME') continue;
    if (/(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|CREDENTIAL|AUTH)/iu.test(name)) continue;
    environment[name] = value;
  }
  environment.CODEX_HOME = codexHome;
  environment.CODEX_SQLITE_HOME = codexHome;
  return environment;
}

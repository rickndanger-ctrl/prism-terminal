# Prism Mac gateway

The Mac gateway connects Prism Terminal on an iPhone to a persistent local Codex App Server. It also provides deterministic everyday Mac commands, focused typing, optional speech synthesis, and compatibility APIs for older Codex Lens clients. The historical package names and `/v1` routes remain for client compatibility.

Start with the [repository setup guide](../../README.md). This is a developer beta, not a sandboxed remote desktop product.

## Run locally

Requirements: macOS with Xcode Command Line Tools, Node.js 26, npm, and a working Codex CLI/account login. Run `codex login` using the same Mac account that starts the gateway. From the repository root:

```sh
npm ci
npm run build
# Set CODEX_LENS_GATEWAY_TOKEN securely in this shell, or use the Keychain slot below.
./scripts/run-gateway.zsh
```

The startup script resolves the checkout dynamically and supports `CODEX_LENS_NODE` for an explicit Node 26 executable. It does not require an OpenAI API key for terminal chat. API-backed features have separate provider credentials and costs.

Set `CODEX_LENS_TERMINAL_MODEL` to a model supported by your Codex account. Without an override, the accepted build's `gpt-5.6-sol` default and `medium` effort are preserved; that model is not guaranteed to be available to every account. `CODEX_APP_SERVER_CMD` selects an explicit Codex executable.

The pairing bearer token is required. Optional macOS Keychain lookup uses account `codex-lens` (override: `CODEX_LENS_KEYCHAIN_ACCOUNT`) and service `com.codex-lens.gateway.token`. The optional API-key service is `com.codex-lens.gateway.openai-api-key`. The script never prints these values. Do not put tokens into Git, URLs, screenshots, or a public tunnel configuration.

`scripts/install-launch-agent.zsh` is an optional, explicitly invoked installer that replaces the existing `com.codex-lens.gateway` service. It requires the pairing token in Keychain and saves only an allowlist of non-secret model/executable/speech settings. Validate foreground operation first; do not run it while another gateway is handling work.

Default bind address is `127.0.0.1`, port `8787`; `CODEX_LENS_PORT` changes the port. The default SQLite database is in `~/Library/Application Support/CodexLens/`; `CODEX_LENS_DB_PATH` can select another private path. Phone access requires an operator-managed authenticated private network/proxy. Do not expose the gateway unauthenticated to the internet.

## Execution and safety boundaries

- The terminal is a persistent Codex agent connection, not a raw PTY shell. Its threads and request receipts are durable; reconnecting streams does not repeat accepted commands.
- Terminal turns currently run with `danger-full-access` and approval policy `never`. This is broad access to the logged-in Mac. It is **not** a filesystem sandbox, a blanket ban on commits, or a guarantee that every harmful instruction is prevented. Only pair trusted clients and submit tasks you authorize.
- Project-scoped workflows have additional allowlist/approval controls. These do not automatically constrain the broad-access terminal.
- Fast command-pad actions use fixed, validated native operations. Focused typing inserts only into a supported, verified editable field and does not press Enter or Send. Password fields and terminal windows are blocked. Uncertain outcomes are not automatically retried.
- Screen/page/document text is untrusted data, not authorization. Permission refusals must not be bypassed through another backend. Inspect requested actions before granting Mac permissions.
- Restarting the gateway interrupts its owned agent process group. In-flight outcomes become uncertain and require review; saved history is not proof an action completed.

## Computer-use prerequisites

Deterministic controls require the relevant macOS Accessibility and Automation permissions. General Codex computer use additionally depends on locally installed supported tooling; the gateway does not download or grant permission to it.

The isolated worker discovers the native Codex computer-use helper under `~/.codex/computer-use/`, optional ChatGPT-bundled `cua_node/bin/node_repl`, and optional `~/.local/bin/clawdcursor`. It verifies native MCP readiness before dispatch when that helper is present. Tool availability depends on the user's installed desktop apps and supported interfaces. A missing tool must be configured, not worked around by weakening a permission boundary.

## Optional integrations

- [Local Kokoro speech](../../local-voice/README.md) is disabled by default. Set absolute `CODEX_LENS_VOICE_PYTHON` and `CODEX_LENS_VOICE_WORKER` paths after explicitly installing its optional dependencies/model. No model weights, environment, or user audio are bundled. Speech synthesis does not establish dependable background voice recognition.
- CLEF classification is disabled unless `CODEX_LENS_CLEF_SSH_HOST` and `CODEX_LENS_CLEF_REMOTE_COMMAND` identify an operator-configured adapter. Text travels as bounded stdin JSON, never as part of its fixed SSH command. The optional example adapter requires an independently provisioned, verified runtime via `CODEX_LENS_CLEF_HOME`. Ordinary deterministic commands do not need CLEF or a network model.
- Realtime, GPT-Live, Gemini, research, Gmail and other compatibility features require their own setup. Their presence in source does not mean they are enabled or verified on a fresh installation. No Gmail access or message sending is granted by installing this repository.

## API overview

All protected routes require `Authorization: Bearer <pairing token>`; `/v1/health` is a minimal unauthenticated health check.

| Routes | Purpose |
| --- | --- |
| `/v1/terminal/sessions`, `/connect`, `/:sessionId/turns` | Persistent Codex conversations and task submission |
| `/v1/terminal/:sessionId/events`, `/interrupt` | Cursor-based output streaming and explicit stop |
| `/v1/command-pad`, `/execute`, `/receipts/:requestId` | Validated fast commands and no-replay receipt recovery |
| `/v1/command-pad/classify` | Optional CLEF suggestion; never executes an action itself |
| `/v1/voice/status`, `/v1/voice/speech` | Optional local speech readiness and synthesis |

Other legacy/optional routes are defined in `src/routes`; do not infer enabled capabilities from a route name alone. Never log request bodies, dictated content, provider credentials, or raw tool output while diagnosing connectivity.

## Verification

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=4
npm run test:scripts
npm run build
python3 -m unittest discover -s local-voice -p test_worker.py
```

Tests use injected transports, fixtures and temporary storage; they do not prove physical glasses behavior, real account availability, or background iPhone reliability. Do not run the optional `worker:probe`, `worker:typing`, Gmail or other live diagnostic commands without understanding their effects on your Mac/account.

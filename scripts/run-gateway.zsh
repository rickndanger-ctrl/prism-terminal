#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
security_bin="/usr/bin/security"

# Explicit environment values take precedence. Keychain is an optional local
# convenience; no credential values are written to configuration or logs.
keychain_account="${CODEX_LENS_KEYCHAIN_ACCOUNT:-codex-lens}"
if [[ -z "${CODEX_LENS_GATEWAY_TOKEN:-}" ]]; then
  CODEX_LENS_GATEWAY_TOKEN="$($security_bin find-generic-password -a "$keychain_account" -s com.codex-lens.gateway.token -w 2>/dev/null)" || true
fi
if [[ -z "${CODEX_LENS_GATEWAY_TOKEN:-}" ]]; then
  print -u2 'Set CODEX_LENS_GATEWAY_TOKEN or store com.codex-lens.gateway.token in Keychain.'
  exit 1
fi
export CODEX_LENS_GATEWAY_TOKEN
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_API_KEY="$($security_bin find-generic-password -a "$keychain_account" -s com.codex-lens.gateway.openai-api-key -w 2>/dev/null)" || true
fi
export OPENAI_API_KEY
# Terminal chat uses your existing Codex login. An OpenAI API key is optional
# for separately configured API features. Local speech is also opt-in: set
# CODEX_LENS_VOICE_PYTHON and CODEX_LENS_VOICE_WORKER to absolute paths.
export CODEX_LENS_PORT="${CODEX_LENS_PORT:-8787}"
export CODEX_LENS_HF_ENABLED="${CODEX_LENS_HF_ENABLED:-0}"
export CODEX_LENS_DB_PATH="${CODEX_LENS_DB_PATH:-$HOME/Library/Application Support/CodexLens/gateway.sqlite3}"
mkdir -p "${CODEX_LENS_DB_PATH:h}"

# Prefer an explicit Node binary, then standard Node 26 Homebrew locations.
# Do not accidentally launch under an older login-shell Node installation.
node_bin="${CODEX_LENS_NODE:-}"
if [[ -z "$node_bin" ]]; then
  for candidate in /opt/homebrew/opt/node@26/bin/node /usr/local/opt/node@26/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 26 ? 0 : 1)'; then
      node_bin="$candidate"
      break
    fi
  done
fi
if [[ -z "$node_bin" || ! -x "$node_bin" ]] || ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 26 ? 0 : 1)'; then
  print -u2 'Node.js 26 is required. Set CODEX_LENS_NODE to its absolute executable path.'
  exit 1
fi
export PATH="${node_bin:h}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ ! -f "$repo_root/dist/packages/gateway/src/index.js" ]]; then
  print -u2 'Build the gateway first: npm ci && npm run build'
  exit 1
fi

cd "$repo_root"
exec "$node_bin" dist/packages/gateway/src/index.js

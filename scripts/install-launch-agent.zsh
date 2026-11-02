#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
agent_target="$HOME/Library/LaunchAgents/com.codex-lens.gateway.plist"
logs_dir="$HOME/Library/Logs/CodexLens"
data_dir="$HOME/Library/Application Support/CodexLens"
domain="gui/$(id -u)"

if [[ ! -f "$repo_root/dist/packages/gateway/src/index.js" ]]; then
  print -u2 'Build the gateway first: npm ci && npm run build'
  exit 1
fi
if ! /usr/bin/security find-generic-password -a "${CODEX_LENS_KEYCHAIN_ACCOUNT:-codex-lens}" -s com.codex-lens.gateway.token >/dev/null 2>&1; then
  print -u2 'The LaunchAgent requires the pairing token in Keychain; it cannot inherit a token exported in your Terminal.'
  print -u2 'Use scripts/run-gateway.zsh in the foreground for environment-only configuration.'
  exit 1
fi
mkdir -p "$logs_dir" "$data_dir" "${agent_target:h}"
chmod 700 "$data_dir"
# Build the plist through typed values so spaces and XML characters in the
# checkout path are safe. Never copy credentials into the LaunchAgent.
agent_source="$(mktemp -t prism-gateway-plist)"
trap 'rm -f "$agent_source"' EXIT
plutil -create xml1 "$agent_source"
plutil -insert Label -string com.codex-lens.gateway "$agent_source"
plutil -insert ProgramArguments -array "$agent_source"
plutil -insert ProgramArguments.0 -string /bin/zsh "$agent_source"
plutil -insert ProgramArguments.1 -string "$repo_root/scripts/run-gateway.zsh" "$agent_source"
plutil -insert WorkingDirectory -string "$repo_root" "$agent_source"
plutil -insert RunAtLoad -bool true "$agent_source"
plutil -insert KeepAlive -bool true "$agent_source"
plutil -insert ThrottleInterval -integer 10 "$agent_source"
plutil -insert StandardOutPath -string "$logs_dir/gateway.log" "$agent_source"
plutil -insert StandardErrorPath -string "$logs_dir/gateway.error.log" "$agent_source"
plutil -insert EnvironmentVariables -dictionary "$agent_source"
plutil -insert EnvironmentVariables.PATH -string "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$agent_source"
for configuration_name in CODEX_LENS_NODE CODEX_LENS_TERMINAL_MODEL CODEX_APP_SERVER_CMD CODEX_LENS_KEYCHAIN_ACCOUNT CODEX_LENS_PORT CODEX_LENS_VOICE_PYTHON CODEX_LENS_VOICE_WORKER; do
  configuration_value="${(P)configuration_name:-}"
  if [[ -n "$configuration_value" ]]; then
    plutil -insert "EnvironmentVariables.$configuration_name" -string "$configuration_value" "$agent_source"
  fi
done
install -m 600 "$agent_source" "$agent_target"

launchctl bootout "$domain/com.codex-lens.gateway" 2>/dev/null || true
bootstrap_succeeded=0
bootstrap_error=""
for attempt in 1 2 3; do
  if bootstrap_error="$(launchctl bootstrap "$domain" "$agent_target" 2>&1)"; then
    bootstrap_succeeded=1
    break
  fi
  if (( attempt < 3 )); then
    sleep 1
  fi
done
if (( bootstrap_succeeded == 0 )); then
  print -r -- "$bootstrap_error" >&2
  echo "Codex Lens gateway LaunchAgent could not be bootstrapped." >&2
  exit 1
fi
launchctl enable "$domain/com.codex-lens.gateway"
launchctl kickstart -k "$domain/com.codex-lens.gateway"

gateway_ready=0
for attempt in {1..15}; do
  if /usr/bin/curl --fail --silent --output /dev/null \
    "http://127.0.0.1:${CODEX_LENS_PORT:-8787}/v1/health"; then
    gateway_ready=1
    break
  fi
  sleep 1
done
if (( gateway_ready == 0 )); then
  echo "Codex Lens gateway started but did not become healthy." >&2
  exit 1
fi

echo "Codex Lens gateway LaunchAgent installed."

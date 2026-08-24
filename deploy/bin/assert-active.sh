#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIG_DIR="/etc/robinhood-chain-monitor"
readonly STATE_DIR="/var/lib/robinhood-chain-monitor"
readonly CURRENT_DIR="/opt/robinhood-chain-monitor/current"
readonly ROLE="${1:-}"

fail() {
  printf 'preflight failed: %s\n' "$*" >&2
  exit 78
}

case "$ROLE" in
  main|fomo) ;;
  *) fail "role must be main or fomo" ;;
esac

[[ -r "$CONFIG_DIR/node-id" ]] || fail "$CONFIG_DIR/node-id is missing"
[[ -r "$CONFIG_DIR/ACTIVE" ]] || fail "node is inactive; run robinhood-activate only after the old node is stopped"

node_id="$(tr -d '[:space:]' < "$CONFIG_DIR/node-id")"
active_id="$(tr -d '[:space:]' < "$CONFIG_DIR/ACTIVE")"
[[ -n "$node_id" && "$active_id" == "$node_id" ]] || fail "ACTIVE marker does not match this node"

[[ -f "$CONFIG_DIR/monitor.env" ]] || fail "$CONFIG_DIR/monitor.env is missing"
env_owner="$(stat -c '%U' -- "$CONFIG_DIR/monitor.env")"
env_mode="$(stat -c '%a' -- "$CONFIG_DIR/monitor.env")"
[[ "$env_owner" == "root" ]] || fail "monitor.env must be owned by root"
[[ "$env_mode" == "600" ]] || fail "monitor.env must have mode 0600"

[[ -d "$CURRENT_DIR" && -f "$CURRENT_DIR/package-lock.json" ]] || fail "no valid current release"
[[ -d "$STATE_DIR" && -w "$STATE_DIR" ]] || fail "$STATE_DIR is not writable"
[[ -x /usr/bin/node ]] || fail "/usr/bin/node is missing"
node_major="$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  fail "/usr/bin/node must be Node.js 22 or newer"
fi

if [[ "$ROLE" == "fomo" ]]; then
  [[ -x /usr/local/bin/gmgn-cli ]] || fail "/usr/local/bin/gmgn-cli is not installed"
  [[ "$(PATH=/usr/bin:/bin /usr/local/bin/gmgn-cli --version)" == "1.5.4" ]] \
    || fail "/usr/local/bin/gmgn-cli must be version 1.5.4"
fi

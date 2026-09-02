#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICE_USER="robinhood-monitor"
readonly SERVICE_GROUP="robinhood-monitor"
readonly CONFIG_DIR="/etc/robinhood-chain-monitor"
readonly STATE_DIR="/var/lib/robinhood-chain-monitor"
readonly APP_DIR="/opt/robinhood-chain-monitor"
readonly LIBEXEC_DIR="/usr/local/libexec/robinhood-monitor"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly REPO_DIR

fail() {
  printf 'install failed: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ -r /etc/os-release ]] || fail "/etc/os-release is unavailable"

if [[ -e "$CONFIG_DIR/ACTIVE" ]] \
  || systemctl is-active --quiet robinhood-monitor.service 2>/dev/null \
  || systemctl is-active --quiet robinhood-fomo.service 2>/dev/null; then
  fail "refusing to install over an active node; run robinhood-deactivate --confirm first"
fi

# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || fail "Ubuntu 24.04 is required"

for command_name in rsync systemctl install stat pgrep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
[[ -x /usr/bin/node ]] || fail "/usr/bin/node is required; nvm-only Node installations are unsupported"
[[ -x /usr/bin/npm ]] || fail "/usr/bin/npm is required; nvm-only npm installations are unsupported"

node_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "could not determine the Node.js version"
(( node_major >= 22 )) || fail "/usr/bin/node must be Node.js 22 or newer"
PATH=/usr/bin:/bin /usr/bin/npm --version >/dev/null 2>&1 \
  || fail "/usr/bin/npm is not usable with /usr/bin/node"

if ! getent group "$SERVICE_GROUP" >/dev/null; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "$SERVICE_GROUP" \
    --home-dir "$STATE_DIR" \
    --shell /usr/sbin/nologin \
    "$SERVICE_USER"
fi
[[ "$(id -gn "$SERVICE_USER")" == "$SERVICE_GROUP" ]] || fail "$SERVICE_USER has an unexpected primary group"

install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/releases" "$CONFIG_DIR" "$LIBEXEC_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STATE_DIR"

printf 'Installing the pinned public GMGN CLI (1.5.4)...\n'
PATH=/usr/bin:/bin /usr/bin/npm install \
  --global \
  --prefix /usr/local \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  gmgn-cli@1.5.4
readonly GMGN_PATH="/usr/local/bin/gmgn-cli"
[[ -x "$GMGN_PATH" ]] || fail "$GMGN_PATH was not installed"
[[ "$(PATH=/usr/bin:/bin "$GMGN_PATH" --version)" == "1.5.4" ]] || fail "gmgn-cli version verification failed"

install -o root -g root -m 0755 "$REPO_DIR/deploy/bin/assert-active.sh" "$LIBEXEC_DIR/assert-active.sh"
install -o root -g root -m 0755 "$REPO_DIR/deploy/bin/release.sh" /usr/local/sbin/robinhood-release
install -o root -g root -m 0755 "$REPO_DIR/deploy/bin/switch-release.sh" /usr/local/sbin/robinhood-switch-release
install -o root -g root -m 0755 "$REPO_DIR/deploy/bin/activate-node.sh" /usr/local/sbin/robinhood-activate
install -o root -g root -m 0755 "$REPO_DIR/deploy/bin/deactivate-node.sh" /usr/local/sbin/robinhood-deactivate

for unit_file in "$REPO_DIR"/deploy/systemd/*; do
  [[ -f "$unit_file" ]] || continue
  install -o root -g root -m 0644 "$unit_file" "/etc/systemd/system/$(basename -- "$unit_file")"
done

runtime_tmp="$(mktemp "$CONFIG_DIR/.runtime.env.XXXXXX")"
trap 'rm -f -- "${runtime_tmp:-}"' EXIT
{
  printf 'DATA_DIR=%s\n' "$STATE_DIR"
  printf 'ONCE=false\n'
  printf 'FOMO_CALL_STANDALONE=true\n'
  printf 'FOMO_CALL_GMGN_CLI_PATH=%s\n' "$GMGN_PATH"
} > "$runtime_tmp"
chown root:root "$runtime_tmp"
chmod 0644 "$runtime_tmp"
mv -f -- "$runtime_tmp" "$CONFIG_DIR/runtime.env"
trap - EXIT

if [[ ! -s "$CONFIG_DIR/node-id" ]]; then
  machine_id="$(tr -cd 'A-Za-z0-9._-' < /etc/machine-id)"
  [[ -n "$machine_id" ]] || fail "/etc/machine-id is empty"
  node_tmp="$(mktemp "$CONFIG_DIR/.node-id.XXXXXX")"
  printf 'ubuntu-%s\n' "$machine_id" > "$node_tmp"
  chown root:root "$node_tmp"
  chmod 0444 "$node_tmp"
  mv -f -- "$node_tmp" "$CONFIG_DIR/node-id"
fi

install -o root -g root -m 0644 "$REPO_DIR/.env.example" "$CONFIG_DIR/monitor.env.example"
if [[ ! -e "$CONFIG_DIR/health.env" ]]; then
  health_tmp="$(mktemp "$CONFIG_DIR/.health.env.XXXXXX")"
  {
    printf 'HEALTH_ROBINHOOD_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_BINANCE_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_BSC_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_GITHUB_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_PLATFORM_CAPABILITY_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_FOMO_STATE_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_FOMO_CHECKPOINT_MAX_AGE_SECONDS=900\n'
    printf 'HEALTH_FOMO_X_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_FOMO_THESIS_MAX_AGE_SECONDS=180\n'
    printf 'HEALTH_OUTBOX_MAX_PENDING_AGE_SECONDS=60\n'
    printf 'HEALTH_REQUIRE_FOMO_STATE=true\n'
    printf 'HEALTH_REQUIRE_FOMO_CHECKPOINT=true\n'
    printf 'HEALTH_REQUIRE_FOMO_X=true\n'
    printf 'HEALTH_REQUIRE_FOMO_THESIS=true\n'
    printf 'HEALTH_REQUIRE_EXTERNAL_HEARTBEAT=true\n'
    printf 'HEALTH_HEARTBEAT_REQUIRE_COVERAGE_COMPLETE=false\n'
    printf 'HEALTH_HEARTBEAT_TIMEOUT_MS=5000\n'
  } > "$health_tmp"
  chown root:root "$health_tmp"
  chmod 0600 "$health_tmp"
  mv -f -- "$health_tmp" "$CONFIG_DIR/health.env"
fi
chown root:root "$CONFIG_DIR/health.env"
chmod 0600 "$CONFIG_DIR/health.env"

# Installation never makes this server active. Activation is an explicit cutover step.
systemctl daemon-reload
systemctl disable --now \
  robinhood-monitor.target \
  robinhood-monitor.service \
  robinhood-fomo.service \
  robinhood-health.timer >/dev/null 2>&1 || true

printf '\nInstalled in INACTIVE state. Next steps:\n'
printf '  1. sudo robinhood-release %q\n' "$REPO_DIR"
printf '  2. install the real environment as %s/monitor.env (root:root, 0600)\n' "$CONFIG_DIR"
printf '  3. copy and verify durable state in %s\n' "$STATE_DIR"
printf '  4. stop the old Mac node, then run robinhood-switch-release and robinhood-activate\n'

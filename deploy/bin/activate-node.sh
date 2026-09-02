#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIG_DIR="/etc/robinhood-chain-monitor"
readonly STATE_DIR="/var/lib/robinhood-chain-monitor"
readonly CURRENT_LINK="/opt/robinhood-chain-monitor/current"
readonly SERVICE_USER="robinhood-monitor"
readonly ENV_SETTING_READER="/usr/local/libexec/robinhood-monitor/read-env-setting.sh"

fail() {
  printf 'activation failed: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ "$#" -eq 1 && "$1" == "--confirm-old-node-stopped" ]] \
  || fail "usage: robinhood-activate --confirm-old-node-stopped"
[[ -L "$CURRENT_LINK" && -f "$CURRENT_LINK/src/index.js" && -f "$CURRENT_LINK/src/fomo-worker.js" ]] \
  || fail "select a valid release first"
[[ -f "$CONFIG_DIR/monitor.env" ]] || fail "$CONFIG_DIR/monitor.env is missing"
[[ "$(stat -c '%U' -- "$CONFIG_DIR/monitor.env")" == "root" ]] || fail "monitor.env must be root-owned"
env_mode="$(stat -c '%a' -- "$CONFIG_DIR/monitor.env")"
[[ "$env_mode" == "600" ]] || fail "monitor.env must have mode 0600"
[[ -f "$CONFIG_DIR/health.env" ]] || fail "$CONFIG_DIR/health.env is missing"
[[ "$(stat -c '%U' -- "$CONFIG_DIR/health.env")" == "root" ]] || fail "health.env must be root-owned"
health_env_mode="$(stat -c '%a' -- "$CONFIG_DIR/health.env")"
[[ "$health_env_mode" == "600" ]] || fail "health.env must have mode 0600"
grep -Eq '^HEALTH_HEARTBEAT_URL=https://[^[:space:]]+$' "$CONFIG_DIR/health.env" \
  || fail "configure an HTTPS HEALTH_HEARTBEAT_URL in health.env before activation"
[[ -x "$ENV_SETTING_READER" ]] || fail "$ENV_SETTING_READER is missing"
pon_monitor_setting="$("$ENV_SETTING_READER" "$CONFIG_DIR/monitor.env" PON_MONITOR_ENABLED)" \
  || fail "could not read PON_MONITOR_ENABLED from monitor.env"
if [[ "$pon_monitor_setting" == "true" ]]; then
  pon_health_setting="$("$ENV_SETTING_READER" "$CONFIG_DIR/health.env" HEALTH_REQUIRE_PON)" \
    || fail "could not read HEALTH_REQUIRE_PON from health.env"
  [[ "$pon_health_setting" == "true" || "$pon_health_setting" == "1" || "$pon_health_setting" == "yes" ]] \
    || fail "PON_MONITOR_ENABLED=true requires HEALTH_REQUIRE_PON=true in health.env"
fi
[[ -r "$CONFIG_DIR/node-id" ]] || fail "node-id is missing"
[[ -d "$STATE_DIR" ]] || fail "state directory is missing"

if systemctl is-active --quiet robinhood-monitor.service || systemctl is-active --quiet robinhood-fomo.service; then
  fail "monitor services are already running"
fi
if pgrep -u "$SERVICE_USER" -f 'src/(index|fomo-worker)\.js' >/dev/null 2>&1; then
  fail "a manually started monitor process is already running"
fi

# A copied PID lease belongs to the stopped source node. Only remove this exact
# lease after confirming both local services are inactive.
stale_fomo_lock="$STATE_DIR/fomo-call-monitor.lock"
if [[ -d "$stale_fomo_lock" ]]; then
  rm -rf -- "$stale_fomo_lock"
fi

node_id="$(tr -d '[:space:]' < "$CONFIG_DIR/node-id")"
[[ -n "$node_id" ]] || fail "node-id is empty"
active_tmp="$(mktemp "$CONFIG_DIR/.ACTIVE.XXXXXX")"
trap 'rm -f -- "${active_tmp:-}"' EXIT
printf '%s\n' "$node_id" > "$active_tmp"
chown root:root "$active_tmp"
chmod 0444 "$active_tmp"
mv -f -- "$active_tmp" "$CONFIG_DIR/ACTIVE"
trap - EXIT

systemctl disable \
  robinhood-monitor.service \
  robinhood-fomo.service \
  robinhood-health.timer >/dev/null 2>&1 || true
systemctl enable robinhood-monitor.target >/dev/null
if ! systemctl start robinhood-monitor.target; then
  systemctl disable --now robinhood-monitor.target >/dev/null 2>&1 || true
  systemctl stop robinhood-monitor.service robinhood-fomo.service >/dev/null 2>&1 || true
  rm -f -- "$CONFIG_DIR/ACTIVE"
  fail "stack failed to start; ACTIVE marker was removed"
fi
sleep 2
if ! systemctl is-active --quiet robinhood-monitor.service \
  || ! systemctl is-active --quiet robinhood-fomo.service; then
  systemctl disable --now robinhood-monitor.target >/dev/null 2>&1 || true
  systemctl stop robinhood-monitor.service robinhood-fomo.service >/dev/null 2>&1 || true
  rm -f -- "$CONFIG_DIR/ACTIVE"
  fail "a required service did not remain active; ACTIVE marker was removed"
fi

printf 'active node: %s\n' "$node_id"
printf 'verify with: systemctl status robinhood-monitor.service robinhood-fomo.service\n'

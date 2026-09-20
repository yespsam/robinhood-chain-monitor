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

read_monitor_setting() {
  "$ENV_SETTING_READER" "$CONFIG_DIR/monitor.env" "$1" \
    || fail "could not read $1 from monitor.env"
}

enabled_unless_false() {
  [[ "$1" != "false" ]]
}

enabled_only_true() {
  [[ "$1" == "true" ]]
}

require_health_for_enabled_lane() {
  local enabled="$1"
  local health_key="$2"
  local monitor_description="$3"
  [[ "$enabled" == "true" ]] || return 0
  local health_setting
  health_setting="$("$ENV_SETTING_READER" "$CONFIG_DIR/health.env" "$health_key")" \
    || fail "could not read $health_key from health.env"
  [[ "$health_setting" == "true" || "$health_setting" == "1" || "$health_setting" == "yes" ]] \
    || fail "$monitor_description requires $health_key=true in health.env"
}

pon_monitor_setting="$(read_monitor_setting PON_MONITOR_ENABLED)"
morph_monitor_setting="$(read_monitor_setting MORPH_MONITOR_ENABLED)"
flap_quote_monitor_setting="$(read_monitor_setting FLAP_QUOTE_MONITOR_ENABLED)"
four_registry_monitor_setting="$(read_monitor_setting FOUR_REGISTRY_MONITOR_ENABLED)"
uniswap_monitor_setting="$(read_monitor_setting UNISWAP_MONITOR_ENABLED)"
xai_monitor_setting="$(read_monitor_setting XAI_OFFICIAL_MONITOR_ENABLED)"
telegram_monitor_setting="$(read_monitor_setting TELEGRAM_NEWS_MONITOR_ENABLED)"
twitter_monitor_setting="$(read_monitor_setting TWITTER_MONITOR_ENABLED)"
binance_critical_x_setting="$(read_monitor_setting BINANCE_CRITICAL_X_MONITOR_ENABLED)"
focus_critical_x_setting="$(read_monitor_setting FOCUS_CRITICAL_X_MONITOR_ENABLED)"

pon_enabled=false
morph_enabled=false
flap_quote_enabled=false
four_registry_enabled=false
uniswap_enabled=false
xai_enabled=false
telegram_enabled=false
twitter_enabled=false
enabled_only_true "$pon_monitor_setting" && pon_enabled=true
enabled_unless_false "$morph_monitor_setting" && morph_enabled=true
enabled_unless_false "$flap_quote_monitor_setting" && flap_quote_enabled=true
enabled_unless_false "$four_registry_monitor_setting" && four_registry_enabled=true
enabled_unless_false "$uniswap_monitor_setting" && uniswap_enabled=true
enabled_unless_false "$xai_monitor_setting" && xai_enabled=true
enabled_only_true "$telegram_monitor_setting" && telegram_enabled=true
if enabled_unless_false "$twitter_monitor_setting" \
  || enabled_unless_false "$binance_critical_x_setting" \
  || enabled_unless_false "$focus_critical_x_setting" \
  || [[ "$pon_enabled" == "true" ]]; then
  twitter_enabled=true
fi

require_health_for_enabled_lane "$pon_enabled" HEALTH_REQUIRE_PON "PON_MONITOR_ENABLED=true"
require_health_for_enabled_lane "$morph_enabled" HEALTH_REQUIRE_MORPH "Morph monitoring"
require_health_for_enabled_lane "$flap_quote_enabled" HEALTH_REQUIRE_FLAP_QUOTE "Flap quote monitoring"
require_health_for_enabled_lane "$four_registry_enabled" HEALTH_REQUIRE_FOUR_REGISTRY "Four registry monitoring"
require_health_for_enabled_lane "$uniswap_enabled" HEALTH_REQUIRE_UNISWAP "Uniswap monitoring"
require_health_for_enabled_lane "$xai_enabled" HEALTH_REQUIRE_XAI_OFFICIAL "xAI official monitoring"
require_health_for_enabled_lane "$telegram_enabled" HEALTH_REQUIRE_TELEGRAM_NEWS "Telegram news monitoring"
require_health_for_enabled_lane "$twitter_enabled" HEALTH_REQUIRE_TWITTER "effective Twitter monitoring"
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

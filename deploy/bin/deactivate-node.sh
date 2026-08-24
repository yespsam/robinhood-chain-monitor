#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIG_DIR="/etc/robinhood-chain-monitor"
readonly SERVICE_USER="robinhood-monitor"

fail() {
  printf 'deactivation failed: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ "$#" -eq 1 && "$1" == "--confirm" ]] || fail "usage: robinhood-deactivate --confirm"

systemctl disable --now \
  robinhood-monitor.target \
  robinhood-monitor.service \
  robinhood-fomo.service \
  robinhood-health.timer >/dev/null 2>&1 || true
rm -f -- "$CONFIG_DIR/ACTIVE"

if systemctl is-active --quiet robinhood-monitor.service || systemctl is-active --quiet robinhood-fomo.service; then
  fail "a monitor service is still active; inspect it before activating another node"
fi
if pgrep -u "$SERVICE_USER" -f 'src/(index|fomo-worker)\.js' >/dev/null 2>&1; then
  fail "a manually started monitor process is still active"
fi
printf 'node is inactive; it is now safe to transfer final state to the replacement node\n'

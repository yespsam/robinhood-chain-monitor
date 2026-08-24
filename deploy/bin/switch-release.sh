#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/robinhood-chain-monitor"
readonly RELEASES_DIR="$APP_DIR/releases"
readonly CURRENT_LINK="$APP_DIR/current"
readonly CONFIG_DIR="/etc/robinhood-chain-monitor"

fail() {
  printf 'switch failed: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ "$#" -ge 1 && "$#" -le 2 ]] || fail "usage: robinhood-switch-release RELEASE_ID [--restart]"
release_id="$1"
restart="false"
if [[ "$#" -eq 2 ]]; then
  [[ "$2" == "--restart" ]] || fail "the only supported option is --restart"
  restart="true"
fi
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail "invalid release ID"

release_dir="$RELEASES_DIR/$release_id"
[[ -d "$release_dir" && -f "$release_dir/package-lock.json" && -f "$release_dir/src/index.js" ]] \
  || fail "release is incomplete or missing"
[[ ! -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]] || fail "$CURRENT_LINK exists and is not a symlink"

node_is_active="false"
if [[ -r "$CONFIG_DIR/ACTIVE" ]]; then
  node_is_active="true"
  [[ "$restart" == "true" ]] || fail "active nodes must use --restart"
fi
if [[ "$restart" == "true" && "$node_is_active" != "true" ]]; then
  fail "--restart is only valid on an active node"
fi

previous_release=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release="$(readlink -f -- "$CURRENT_LINK" 2>/dev/null || true)"
fi

if [[ "$restart" == "true" ]]; then
  systemctl stop robinhood-monitor.target
fi

temporary_link="$APP_DIR/.current.$$.tmp"
trap 'rm -f -- "${temporary_link:-}"' EXIT
ln -s -- "$release_dir" "$temporary_link"
mv -Tf -- "$temporary_link" "$CURRENT_LINK"
trap - EXIT

if [[ "$restart" == "true" ]]; then
  start_failed="false"
  if ! systemctl start robinhood-monitor.target; then
    start_failed="true"
  else
    sleep 2
    if ! systemctl is-active --quiet robinhood-monitor.service \
      || ! systemctl is-active --quiet robinhood-fomo.service; then
      start_failed="true"
    fi
  fi
  if [[ "$start_failed" == "true" ]]; then
    printf 'new release failed to start; attempting rollback\n' >&2
    systemctl stop robinhood-monitor.target >/dev/null 2>&1 || true
    if [[ -n "$previous_release" && -d "$previous_release" ]]; then
      rollback_link="$APP_DIR/.current.rollback.$$.tmp"
      trap 'rm -f -- "${rollback_link:-}"' EXIT
      ln -s -- "$previous_release" "$rollback_link"
      mv -Tf -- "$rollback_link" "$CURRENT_LINK"
      trap - EXIT
      if systemctl start robinhood-monitor.target; then
        sleep 2
        if systemctl is-active --quiet robinhood-monitor.service \
          && systemctl is-active --quiet robinhood-fomo.service; then
          printf 'rollback release restored: %s\n' "$previous_release" >&2
        else
          printf 'rollback release did not remain healthy; manual recovery required\n' >&2
        fi
      else
        printf 'rollback release could not start; manual recovery required\n' >&2
      fi
    fi
    fail "release switch failed"
  fi
fi

printf 'current release: %s\n' "$release_id"

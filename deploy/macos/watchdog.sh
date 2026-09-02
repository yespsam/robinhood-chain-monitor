#!/bin/sh

# Local launchd watchdog for the two production workers.
# This script deliberately treats upstream health and process liveness as
# different signals: an alive worker is restarted only when its producer-owned
# runtime heartbeat has remained stale in consecutive observations.

set -eu

umask 077

die() {
  printf '%s\n' "watchdog: $*" >&2
  exit 1
}

is_uint() {
  case "${1-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

require_uint() {
  require_name=$1
  require_value=$2
  is_uint "$require_value" || die "$require_name must be an unsigned integer"
}

json_escape() {
  printf '%s' "$1" | /usr/bin/sed \
    -e 's/\\/\\\\/g' \
    -e 's/"/\\"/g' \
    -e 's/	/\\t/g' \
    -e 's//\\r/g'
}

safe_label() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

project_dir=${PROJECT_DIR:?PROJECT_DIR is required}
data_dir=${DATA_DIR:-"$project_dir/data"}
state_dir=${WATCHDOG_STATE_DIR:-"$data_dir/macos-watchdog"}
main_label=${MAIN_LABEL:-com.qohfq.robinhood-launchpad-monitor}
fomo_label=${FOMO_LABEL:-com.qohfq.fomo-call-monitor}
main_heartbeat=${MAIN_HEARTBEAT:-"$data_dir/main-runtime-heartbeat.json"}
fomo_heartbeat=${FOMO_HEARTBEAT:-"$data_dir/fomo-runtime-heartbeat.json"}
main_health_report=${MAIN_HEALTH_REPORT:-}
fomo_health_report=${FOMO_HEALTH_REPORT:-}
stale_seconds=${WATCHDOG_STALE_SECONDS:-120}
stale_samples=${WATCHDOG_STALE_SAMPLES:-2}
cooldown_seconds=${WATCHDOG_COOLDOWN_SECONDS:-600}
restart_grace_seconds=${WATCHDOG_RESTART_GRACE_SECONDS:-60}
network_host=${WATCHDOG_NETWORK_HOST:-api.telegram.org}
network_url=${WATCHDOG_NETWORK_URL:-https://api.telegram.org}
heartbeat_future_tolerance_seconds=${WATCHDOG_HEARTBEAT_FUTURE_TOLERANCE_SECONDS:-60}
now_epoch=${WATCHDOG_NOW_EPOCH:-$(/bin/date +%s)}
launchctl_bin=${WATCHDOG_LAUNCHCTL_BIN:-/bin/launchctl}
kill_bin=${WATCHDOG_KILL_BIN:-/bin/kill}
scutil_bin=${WATCHDOG_SCUTIL_BIN:-/usr/sbin/scutil}
curl_bin=${WATCHDOG_CURL_BIN:-/usr/bin/curl}
stat_bin=${WATCHDOG_STAT_BIN:-/usr/bin/stat}
sleep_bin=${WATCHDOG_SLEEP_BIN:-/bin/sleep}
plutil_bin=${WATCHDOG_PLUTIL_BIN:-/usr/bin/plutil}
dry_run=${WATCHDOG_DRY_RUN:-false}
domain="gui/$(/usr/bin/id -u)"

safe_label "$main_label" || die "MAIN_LABEL contains unsupported characters"
safe_label "$fomo_label" || die "FOMO_LABEL contains unsupported characters"
require_uint WATCHDOG_STALE_SECONDS "$stale_seconds"
require_uint WATCHDOG_STALE_SAMPLES "$stale_samples"
require_uint WATCHDOG_COOLDOWN_SECONDS "$cooldown_seconds"
require_uint WATCHDOG_RESTART_GRACE_SECONDS "$restart_grace_seconds"
require_uint WATCHDOG_HEARTBEAT_FUTURE_TOLERANCE_SECONDS "$heartbeat_future_tolerance_seconds"
require_uint WATCHDOG_NOW_EPOCH "$now_epoch"
[ "$stale_seconds" -ge 120 ] || die "WATCHDOG_STALE_SECONDS must be at least 120"
[ "$stale_samples" -ge 2 ] || die "WATCHDOG_STALE_SAMPLES must be at least 2"
[ "$cooldown_seconds" -ge 600 ] || die "WATCHDOG_COOLDOWN_SECONDS must be at least 600"
[ "$restart_grace_seconds" -ge 30 ] || die "WATCHDOG_RESTART_GRACE_SECONDS must be at least 30"
case "$dry_run" in true|false) ;; *) die "WATCHDOG_DRY_RUN must be true or false" ;; esac
case "$network_url" in https://*) ;; *) die "WATCHDOG_NETWORK_URL must use https" ;; esac

case "$state_dir" in
  ''|/) die "WATCHDOG_STATE_DIR is unsafe" ;;
esac
[ ! -L "$state_dir" ] || die "WATCHDOG_STATE_DIR must not be a symlink"
/bin/mkdir -p "$state_dir"
/bin/chmod 700 "$state_dir"

lock_dir="$state_dir/run.lock"
lock_owner="$lock_dir/owner"
if ! /bin/mkdir "$lock_dir" 2>/dev/null; then
  # launchd normally coalesces timers. The lock also protects manual runs, and
  # its owner file lets a later run recover after SIGKILL or a crash.
  [ ! -L "$lock_dir" ] || die "watchdog lock must not be a symlink"
  existing_owner=$(/bin/cat "$lock_owner" 2>/dev/null || true)
  if is_uint "$existing_owner" && [ "$existing_owner" -gt 1 ] && "$kill_bin" -0 "$existing_owner" 2>/dev/null; then
    exit 0
  fi
  /bin/rm -f -- "$lock_owner"
  /bin/rmdir "$lock_dir" 2>/dev/null || exit 0
  /bin/mkdir "$lock_dir" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$lock_owner"
/bin/chmod 600 "$lock_owner"
state_tmp=
report_tmp=
cleanup() {
  [ -z "$state_tmp" ] || /bin/rm -f -- "$state_tmp"
  [ -z "$report_tmp" ] || /bin/rm -f -- "$report_tmp"
  /bin/rm -f -- "$lock_owner"
  /bin/rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

state_file="$state_dir/state.tsv"
report_file="$state_dir/health.json"
state_tmp="$state_dir/.state.$$.tmp"
report_tmp="$state_dir/.health.$$.tmp"
: > "$state_tmp"
: > "$report_tmp"
/bin/chmod 600 "$state_tmp" "$report_tmp"

state_value() {
  state_id=$1
  state_field=$2
  if [ ! -f "$state_file" ]; then
    printf '0\n'
    return
  fi
  /usr/bin/awk -F '\t' -v wanted="$state_id" -v field="$state_field" \
    '$1 == wanted { print $field; found=1; exit } END { if (!found) print 0 }' "$state_file"
}

service_pid() {
  service_label=$1
  "$launchctl_bin" print "$domain/$service_label" 2>/dev/null \
    | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }'
}

pid_alive() {
  alive_pid=${1-}
  is_uint "$alive_pid" || return 1
  [ "$alive_pid" -gt 1 ] || return 1
  "$kill_bin" -0 "$alive_pid" 2>/dev/null
}

heartbeat_epoch() {
  heartbeat_path=$1
  if [ ! -f "$heartbeat_path" ] || [ -L "$heartbeat_path" ]; then
    printf '0\n'
    return
  fi
  heartbeat_mtime=$("$stat_bin" -f '%m' "$heartbeat_path" 2>/dev/null || printf '0')
  if is_uint "$heartbeat_mtime" && [ "$heartbeat_mtime" -le $((now_epoch + heartbeat_future_tolerance_seconds)) ]; then
    printf '%s\n' "$heartbeat_mtime"
  else
    # A future mtime beyond the small clock-skew allowance is invalid. Treat
    # it as missing/stale so a frozen file cannot hide behind a bad clock.
    printf '0\n'
  fi
}

source_status() {
  health_path=${1-}
  if [ -z "$health_path" ] || [ ! -f "$health_path" ] || [ -L "$health_path" ]; then
    printf 'unknown\n'
    return
  fi
  health_mtime=$("$stat_bin" -f '%m' "$health_path" 2>/dev/null || printf '0')
  if ! is_uint "$health_mtime" || [ "$health_mtime" -eq 0 ]; then
    printf 'unknown\n'
    return
  fi
  if [ "$health_mtime" -le "$now_epoch" ] && [ $((now_epoch - health_mtime)) -gt "$stale_seconds" ]; then
    # A stale report cannot indefinitely mask a genuinely stuck process.
    printf 'unknown\n'
    return
  fi
  health_status=$("$plutil_bin" -extract sourceStatus raw -o - "$health_path" 2>/dev/null || true)
  if [ -z "$health_status" ]; then
    health_status=$("$plutil_bin" -extract status raw -o - "$health_path" 2>/dev/null || true)
  fi
  case "$health_status" in
    healthy|source_limited|rate_limited|offline|degraded|partial|unknown) printf '%s\n' "$health_status" ;;
    *) printf 'unknown\n' ;;
  esac
}

network_status() {
  if [ -n "${WATCHDOG_NETWORK_STATUS:-}" ]; then
    case "$WATCHDOG_NETWORK_STATUS" in
      reachable|unreachable|unknown) printf '%s\n' "$WATCHDOG_NETWORK_STATUS"; return ;;
      *) die "WATCHDOG_NETWORK_STATUS must be reachable, unreachable, or unknown" ;;
    esac
  fi
  reachability=$("$scutil_bin" -r "$network_host" 2>/dev/null || true)
  case "$reachability" in
    *"Not Reachable"*) printf 'unreachable\n' ;;
    *"Reachable"*)
      # A default route can survive while Wi-Fi or a VPN tunnel is dead. A
      # bounded TLS handshake confirms the path the alert sender actually uses.
      if "$curl_bin" --head --proto '=https' --tlsv1.2 \
        --connect-timeout 3 --max-time 4 --silent --output /dev/null \
        "$network_url" 2>/dev/null; then
        printf 'reachable\n'
      else
        printf 'unreachable\n'
      fi
      ;;
    *) printf 'unknown\n' ;;
  esac
}

controlled_restart() {
  restart_label=$1
  restart_old_pid=${2-}
  restart_action=failed

  if [ "$dry_run" = true ]; then
    printf '%s\n' "watchdog: dry-run restart $restart_label" >&2
    restart_action=dry_run
    return 0
  fi

  if pid_alive "$restart_old_pid"; then
    "$launchctl_bin" kill SIGTERM "$domain/$restart_label" 2>/dev/null || true
    grace_left=$restart_grace_seconds
    while [ "$grace_left" -gt 0 ]; do
      "$sleep_bin" 1
      restart_new_pid=$(service_pid "$restart_label" || true)
      if [ -n "$restart_new_pid" ] && [ "$restart_new_pid" != "$restart_old_pid" ] && pid_alive "$restart_new_pid"; then
        restart_action=graceful
        return 0
      fi
      if ! pid_alive "$restart_old_pid"; then
        if "$launchctl_bin" kickstart "$domain/$restart_label" 2>/dev/null; then
          restart_action=kickstart
          return 0
        fi
      fi
      grace_left=$((grace_left - 1))
    done
    if "$launchctl_bin" kickstart -k "$domain/$restart_label" 2>/dev/null; then
      restart_action=forced_kickstart
      return 0
    fi
    return 1
  fi

  if "$launchctl_bin" kickstart "$domain/$restart_label" 2>/dev/null; then
    restart_action=kickstart
    return 0
  fi
  return 1
}

network=$(network_status)
restart_performed=false
report_rows=

inspect_service() {
  service_id=$1
  service_label=$2
  heartbeat_path=$3
  health_report=$4

  previous_count=$(state_value "$service_id" 2)
  previous_restart=$(state_value "$service_id" 3)
  previous_failure_kind=$(state_value "$service_id" 4)
  is_uint "$previous_count" || previous_count=0
  is_uint "$previous_restart" || previous_restart=0

  current_pid=$(service_pid "$service_label" || true)
  if pid_alive "$current_pid"; then
    process_state=alive
  else
    process_state=missing
    current_pid=0
  fi

  heartbeat_at=$(heartbeat_epoch "$heartbeat_path")
  if [ "$heartbeat_at" -gt "$now_epoch" ]; then
    heartbeat_age=0
  elif [ "$heartbeat_at" -eq 0 ]; then
    heartbeat_age=$((stale_seconds + 1))
  else
    heartbeat_age=$((now_epoch - heartbeat_at))
  fi
  upstream_status=$(source_status "$health_report")
  next_count=0
  reason=healthy
  failure_kind=none
  action=none

  if [ "$process_state" = missing ]; then
    case "$upstream_status" in
      source_limited|rate_limited|offline|degraded|partial)
        reason="upstream_$upstream_status"
        ;;
      *)
        case "$network" in
          unreachable|unknown)
            reason="network_$network"
            ;;
          reachable)
            reason=process_missing
            failure_kind=process_missing
            next_count=$((previous_count + 1))
            ;;
        esac
        ;;
    esac
  elif [ "$heartbeat_age" -gt "$stale_seconds" ]; then
    case "$upstream_status" in
      source_limited|rate_limited|offline|degraded|partial)
        reason="upstream_$upstream_status"
        next_count=0
        ;;
      *)
        case "$network" in
          unreachable|unknown)
            reason="network_$network"
            next_count=0
            ;;
          reachable)
            reason=heartbeat_stale
            failure_kind=heartbeat_stale
            next_count=$((previous_count + 1))
            ;;
        esac
        ;;
    esac
  fi

  # A missing process followed by a live-but-stale process (or the reverse)
  # is not two confirmations of the same failure. Start the counter over.
  if [ "$failure_kind" != none ] && [ "$previous_failure_kind" != "$failure_kind" ]; then
    next_count=1
  fi
  if [ "$next_count" -gt "$stale_samples" ]; then
    next_count=$stale_samples
  fi

  cooldown_remaining=0
  if [ "$previous_restart" -gt 0 ] && [ "$now_epoch" -lt $((previous_restart + cooldown_seconds)) ]; then
    cooldown_remaining=$((previous_restart + cooldown_seconds - now_epoch))
  fi

  if [ "$next_count" -ge "$stale_samples" ]; then
    if [ "$cooldown_remaining" -gt 0 ]; then
      reason=cooldown
    elif [ "$restart_performed" = true ]; then
      reason=restart_deferred
    else
      # The cooldown starts when an attempt begins, even if launchctl returns an
      # error after SIGTERM. This prevents a partial failure from retrying every
      # minute and becoming its own restart storm.
      previous_restart=$now_epoch
      cooldown_remaining=$cooldown_seconds
      restart_performed=true
      if controlled_restart "$service_label" "$current_pid"; then
        action=$restart_action
        next_count=0
        failure_kind=none
      else
        action=restart_failed
      fi
    fi
  fi

  printf '%s\t%s\t%s\t%s\n' "$service_id" "$next_count" "$previous_restart" "$failure_kind" >> "$state_tmp"
  row=$(printf '{"id":"%s","label":"%s","process":"%s","pid":%s,"heartbeat":"%s","heartbeatAgeSeconds":%s,"sourceStatus":"%s","consecutiveStale":%s,"cooldownRemainingSeconds":%s,"reason":"%s","action":"%s"}' \
    "$(json_escape "$service_id")" \
    "$(json_escape "$service_label")" \
    "$(json_escape "$process_state")" \
    "$current_pid" \
    "$(json_escape "$heartbeat_path")" \
    "$heartbeat_age" \
    "$(json_escape "$upstream_status")" \
    "$next_count" \
    "$cooldown_remaining" \
    "$(json_escape "$reason")" \
    "$(json_escape "$action")")
  if [ -z "$report_rows" ]; then
    report_rows=$row
  else
    report_rows="$report_rows,$row"
  fi
}

inspect_service main "$main_label" "$main_heartbeat" "$main_health_report"
inspect_service fomo "$fomo_label" "$fomo_heartbeat" "$fomo_health_report"

printf '{"version":1,"checkedAtEpoch":%s,"network":"%s","limits":{"staleSeconds":%s,"staleSamples":%s,"cooldownSeconds":%s},"services":[%s]}\n' \
  "$now_epoch" "$(json_escape "$network")" "$stale_seconds" "$stale_samples" "$cooldown_seconds" "$report_rows" > "$report_tmp"

/bin/mv -f "$state_tmp" "$state_file"
/bin/mv -f "$report_tmp" "$report_file"
/bin/chmod 600 "$state_file" "$report_file"

exit 0

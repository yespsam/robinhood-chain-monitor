#!/bin/sh

# Independent, fail-closed reconnect guard for the configured VPN cat
# NetworkExtension. It never restarts or signals the production workers.

set -eu

umask 077

die() {
  printf '%s\n' "vpn-watchdog: $*" >&2
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

safe_bundle_id() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

enabled=${VPN_WATCHDOG_ENABLED:-true}
bundle_id=${VPN_WATCHDOG_BUNDLE_ID:-com.vpn.cat}
state_dir=${VPN_WATCHDOG_STATE_DIR:?VPN_WATCHDOG_STATE_DIR is required}
failure_samples=${VPN_WATCHDOG_FAILURE_SAMPLES:-2}
cooldown_seconds=${VPN_WATCHDOG_COOLDOWN_SECONDS:-600}
attempt_window_seconds=${VPN_WATCHDOG_ATTEMPT_WINDOW_SECONDS:-3600}
max_attempts=${VPN_WATCHDOG_MAX_ATTEMPTS:-3}
circuit_seconds=${VPN_WATCHDOG_CIRCUIT_SECONDS:-3600}
post_start_wait_seconds=${VPN_WATCHDOG_POST_START_WAIT_SECONDS:-2}
underlay_url_primary=${VPN_WATCHDOG_UNDERLAY_URL_PRIMARY:-https://www.baidu.com/}
underlay_url_secondary=${VPN_WATCHDOG_UNDERLAY_URL_SECONDARY:-https://www.aliyun.com/}
scutil_bin=${VPN_WATCHDOG_SCUTIL_BIN:-/usr/sbin/scutil}
curl_bin=${VPN_WATCHDOG_CURL_BIN:-/usr/bin/curl}
route_bin=${VPN_WATCHDOG_ROUTE_BIN:-/sbin/route}
kill_bin=${VPN_WATCHDOG_KILL_BIN:-/bin/kill}
date_bin=${VPN_WATCHDOG_DATE_BIN:-/bin/date}
sleep_bin=${VPN_WATCHDOG_SLEEP_BIN:-/bin/sleep}
sync_bin=${VPN_WATCHDOG_SYNC_BIN:-/bin/sync}
now_epoch=${VPN_WATCHDOG_NOW_EPOCH:-$("$date_bin" +%s)}

case "$enabled" in true|false) ;; *) die "VPN_WATCHDOG_ENABLED must be true or false" ;; esac
safe_bundle_id "$bundle_id" || die "VPN_WATCHDOG_BUNDLE_ID contains unsupported characters"
require_uint VPN_WATCHDOG_FAILURE_SAMPLES "$failure_samples"
require_uint VPN_WATCHDOG_COOLDOWN_SECONDS "$cooldown_seconds"
require_uint VPN_WATCHDOG_ATTEMPT_WINDOW_SECONDS "$attempt_window_seconds"
require_uint VPN_WATCHDOG_MAX_ATTEMPTS "$max_attempts"
require_uint VPN_WATCHDOG_CIRCUIT_SECONDS "$circuit_seconds"
require_uint VPN_WATCHDOG_POST_START_WAIT_SECONDS "$post_start_wait_seconds"
require_uint VPN_WATCHDOG_NOW_EPOCH "$now_epoch"
[ "$failure_samples" -ge 2 ] || die "VPN_WATCHDOG_FAILURE_SAMPLES must be at least 2"
[ "$cooldown_seconds" -ge 600 ] || die "VPN_WATCHDOG_COOLDOWN_SECONDS must be at least 600"
[ "$attempt_window_seconds" -ge 3600 ] || die "VPN_WATCHDOG_ATTEMPT_WINDOW_SECONDS must be at least 3600"
[ "$max_attempts" -ge 1 ] || die "VPN_WATCHDOG_MAX_ATTEMPTS must be positive"
[ "$max_attempts" -le 10 ] || die "VPN_WATCHDOG_MAX_ATTEMPTS must not exceed 10"
[ "$circuit_seconds" -ge 3600 ] || die "VPN_WATCHDOG_CIRCUIT_SECONDS must be at least 3600"
[ "$post_start_wait_seconds" -le 10 ] || die "VPN_WATCHDOG_POST_START_WAIT_SECONDS must not exceed 10"
case "$underlay_url_primary" in https://*) ;; *) die "VPN_WATCHDOG_UNDERLAY_URL_PRIMARY must use https" ;; esac
case "$underlay_url_secondary" in https://*) ;; *) die "VPN_WATCHDOG_UNDERLAY_URL_SECONDARY must use https" ;; esac
case "$state_dir" in ''|/) die "VPN_WATCHDOG_STATE_DIR is unsafe" ;; esac

[ ! -L "$state_dir" ] || die "VPN_WATCHDOG_STATE_DIR must not be a symlink"
/bin/mkdir -p "$state_dir"
/bin/chmod 700 "$state_dir"

lock_dir="$state_dir/run.lock"
lock_owner="$lock_dir/owner"
if ! /bin/mkdir "$lock_dir" 2>/dev/null; then
  [ ! -L "$lock_dir" ] || die "lock directory must not be a symlink"
  existing_owner=$(/bin/cat "$lock_owner" 2>/dev/null || true)
  if is_uint "$existing_owner" && [ "$existing_owner" -gt 1 ] \
    && "$kill_bin" -0 "$existing_owner" 2>/dev/null; then
    exit 0
  fi
  /bin/rm -f -- "$lock_owner"
  /bin/rmdir "$lock_dir" 2>/dev/null || exit 0
  /bin/mkdir "$lock_dir" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$lock_owner"
/bin/chmod 600 "$lock_owner"

state_file="$state_dir/state.tsv"
report_file="$state_dir/health.json"
state_tmp="$state_dir/.state.$$.tmp"
report_tmp="$state_dir/.health.$$.tmp"
cleanup() {
  /bin/rm -f -- "$state_tmp" "$report_tmp" "$lock_owner"
  /bin/rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

[ ! -L "$state_file" ] || die "state file must not be a symlink"
[ ! -L "$report_file" ] || die "health report must not be a symlink"

state_value() {
  state_key=$1
  state_default=$2
  if [ ! -f "$state_file" ]; then
    printf '%s\n' "$state_default"
    return
  fi
  /usr/bin/awk -F '\t' -v wanted="$state_key" -v fallback="$state_default" \
    '$1 == wanted { print $2; found=1; exit } END { if (!found) print fallback }' "$state_file"
}

previous_count=$(state_value consecutive_disconnected 0)
last_attempt=$(state_value last_attempt_epoch 0)
window_started=$(state_value attempt_window_started_epoch 0)
attempts_in_window=$(state_value attempts_in_window 0)
circuit_until=$(state_value circuit_until_epoch 0)
last_checked=$(state_value last_checked_epoch 0)
previous_failure_kind=$(state_value failure_kind none)
for state_number in "$previous_count" "$last_attempt" "$window_started" "$attempts_in_window" "$circuit_until" "$last_checked"; do
  if ! is_uint "$state_number"; then
    previous_count=0
    last_attempt=0
    window_started=0
    attempts_in_window=0
    circuit_until=0
    last_checked=0
    previous_failure_kind=none
    break
  fi
done
case "$previous_failure_kind" in none|disconnected_underlay_reachable) ;; *) previous_failure_kind=none ;; esac

write_state_atomic() {
  {
    printf 'version\t1\n'
    printf 'consecutive_disconnected\t%s\n' "$next_count"
    printf 'last_attempt_epoch\t%s\n' "$last_attempt"
    printf 'attempt_window_started_epoch\t%s\n' "$window_started"
    printf 'attempts_in_window\t%s\n' "$attempts_in_window"
    printf 'circuit_until_epoch\t%s\n' "$circuit_until"
    printf 'last_checked_epoch\t%s\n' "$state_checked_epoch"
    printf 'failure_kind\t%s\n' "$failure_kind"
  } > "$state_tmp"
  /bin/chmod 600 "$state_tmp"
  /bin/mv -f "$state_tmp" "$state_file"
  /bin/chmod 600 "$state_file"
}

# A backwards wall clock may only make the guard more conservative. Preserve
# cooldown/circuit state and the high-water observation until time catches up.
clock_rollback=false
state_checked_epoch=$now_epoch
if { [ "$last_checked" -gt 0 ] && [ "$now_epoch" -lt "$last_checked" ]; } \
  || { [ "$last_attempt" -gt 0 ] && [ "$now_epoch" -lt "$last_attempt" ]; } \
  || { [ "$window_started" -gt 0 ] && [ "$now_epoch" -lt "$window_started" ]; }; then
  clock_rollback=true
  state_checked_epoch=$last_checked
fi

# A circuit is a full quiet hour starting with the third reconnect attempt.
# Attempts are forgotten only after a full hour without another attempt; this
# conservative sliding window prevents a fourth attempt across hour boundaries.
if [ "$clock_rollback" = false ] && [ "$circuit_until" -gt 0 ] \
  && [ "$now_epoch" -ge "$circuit_until" ]; then
  circuit_until=0
  window_started=0
  attempts_in_window=0
fi
if [ "$clock_rollback" = false ] && [ "$circuit_until" -eq 0 ] \
  && [ "$last_attempt" -gt 0 ] \
  && [ "$now_epoch" -ge $((last_attempt + attempt_window_seconds)) ]; then
  window_started=0
  attempts_in_window=0
fi

discover_service_id() {
  discovery_output=$("$scutil_bin" --nc list 2>/dev/null || true)
  printf '%s\n' "$discovery_output" | /usr/bin/awk -v suffix=" [VPN:$bundle_id]" '
    {
      line = $0
      sub(/[[:space:]]+$/, "", line)
    }
    length(line) >= length(suffix) \
      && substr(line, length(line) - length(suffix) + 1) == suffix {
      matches += 1
      if (substr(line, 1, 1) == "*") enabled_matches += 1
      for (i = 1; i <= NF; i += 1) {
        if (length($i) == 36 && $i ~ /^[[:xdigit:]-]+$/) {
          ids += 1
          id = $i
        }
      }
    }
    END {
      if (matches == 1 && enabled_matches == 1 && ids == 1) print id
    }
  '
}

normalize_control_status() {
  status_id=$1
  status_line=$("$scutil_bin" --nc status "$status_id" 2>/dev/null \
    | /usr/bin/sed -n '1{s/\r$//;p;}' || true)
  case "$status_line" in
    Connected) printf 'connected\n' ;;
    Disconnected) printf 'disconnected\n' ;;
    Connecting) printf 'connecting\n' ;;
    Disconnecting) printf 'disconnecting\n' ;;
    Reasserting) printf 'reasserting\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

https_probe() {
  probe_interface=$1
  probe_url=$2
  # --disable must be the first curl argument so a user ~/.curlrc cannot add
  # --fail, retries, a proxy, or another option that changes watchdog policy.
  "$curl_bin" --disable --interface "$probe_interface" --noproxy '*' --head \
    --proto '=https' --tlsv1.2 --connect-timeout 3 --max-time 5 \
    --silent --output /dev/null "$probe_url" >/dev/null 2>&1
}

underlay_status() {
  route_output=$("$route_bin" -n get default 2>/dev/null || true)
  underlay_interface=$(printf '%s\n' "$route_output" \
    | /usr/bin/awk '$1 == "interface:" { print $2; exit }')
  if ! printf '%s\n' "$underlay_interface" | /usr/bin/grep -Eq '^en[0-9]+$'; then
    printf 'unknown\n'
    return
  fi
  # curl is deliberately not passed --fail: a valid HTTPS 403, 429, or 5xx is
  # proof of transport reachability and must never cause a VPN reconnect.
  if https_probe "$underlay_interface" "$underlay_url_primary" \
    || https_probe "$underlay_interface" "$underlay_url_secondary"; then
    printf 'reachable\n'
  else
    printf 'unreachable\n'
  fi
}

configured=false
service_id=
control_status=not_checked
post_start_status=not_checked
pre_start_status=not_checked
underlay=not_checked
next_count=0
failure_kind=none
reason=disabled
action=none
after_probe_status=not_checked

if [ "$enabled" = true ]; then
  service_id=$(discover_service_id)
  if printf '%s\n' "$service_id" \
    | /usr/bin/grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$'; then
    configured=true
    control_status=$(normalize_control_status "$service_id")
    case "$control_status" in
      connected)
        reason=connected
        ;;
      connecting|disconnecting|reasserting)
        # Transitional NetworkExtension states are never interrupted.
        reason="vpn_$control_status"
        ;;
      disconnected)
        underlay=$(underlay_status)
        if [ "$underlay" = reachable ]; then
          reason=vpn_disconnected
          failure_kind=disconnected_underlay_reachable
          if [ "$previous_failure_kind" = "$failure_kind" ]; then
            next_count=$((previous_count + 1))
          else
            next_count=1
          fi
          [ "$next_count" -le "$failure_samples" ] || next_count=$failure_samples
        else
          reason="underlay_$underlay"
        fi
        ;;
      *)
        reason=vpn_status_unknown
        ;;
    esac
  else
    service_id=
    reason=not_configured
  fi
fi

# The direct-network probes can take several seconds. Re-discover the exact
# provider and re-read its control state before counting or reserving an
# attempt, so a self-recovery, removal, or UUID replacement cannot race into a
# stale `start` command.
if [ "$failure_kind" = disconnected_underlay_reachable ]; then
  confirmed_service_id=$(discover_service_id)
  if [ "$confirmed_service_id" != "$service_id" ]; then
    configured=false
    service_id=
    control_status=unknown
    after_probe_status=service_changed
    next_count=0
    failure_kind=none
    reason=service_changed_during_probe
  else
    after_probe_status=$(normalize_control_status "$service_id")
    if [ "$after_probe_status" != disconnected ]; then
      control_status=$after_probe_status
      next_count=0
      failure_kind=none
      case "$after_probe_status" in
        connected) reason=vpn_recovered_during_probe ;;
        connecting|disconnecting|reasserting) reason="vpn_$after_probe_status" ;;
        *) reason=vpn_status_unknown ;;
      esac
    fi
  fi
fi

cooldown_remaining=0
if [ "$last_attempt" -gt 0 ] && [ "$now_epoch" -lt $((last_attempt + cooldown_seconds)) ]; then
  cooldown_remaining=$((last_attempt + cooldown_seconds - now_epoch))
fi
circuit_remaining=0
if [ "$circuit_until" -gt "$now_epoch" ]; then
  circuit_remaining=$((circuit_until - now_epoch))
fi

if [ "$failure_kind" = disconnected_underlay_reachable ] \
  && [ "$next_count" -ge "$failure_samples" ]; then
  if [ "$clock_rollback" = true ]; then
    reason=clock_rollback
  elif [ "$circuit_remaining" -gt 0 ]; then
    reason=circuit_open
  elif [ "$cooldown_remaining" -gt 0 ]; then
    reason=cooldown
  elif [ "$attempts_in_window" -ge "$max_attempts" ]; then
    circuit_until=$((now_epoch + circuit_seconds))
    circuit_remaining=$circuit_seconds
    reason=circuit_open
    action=circuit_opened
    printf '%s\n' 'vpn-watchdog: reconnect circuit opened' >&2
  else
    if [ "$window_started" -eq 0 ]; then
      window_started=$now_epoch
      attempts_in_window=0
    fi
    attempts_in_window=$((attempts_in_window + 1))
    last_attempt=$now_epoch
    cooldown_remaining=$cooldown_seconds
    if [ "$attempts_in_window" -ge "$max_attempts" ]; then
      circuit_until=$((now_epoch + circuit_seconds))
      circuit_remaining=$circuit_seconds
    fi

    # Reserve the attempt and its cooldown before invoking NetworkExtension.
    # A SIGKILL, crash, or power loss after `scutil start` must not erase the
    # attempt and permit the next 30-second run to create a reconnect storm.
    write_state_atomic
    "$sync_bin"

    # sync can itself take time under storage pressure. Confirm the same
    # provider is still uniquely configured and disconnected immediately
    # before the only external mutation. A cancelled reservation remains
    # consumed, which is conservative and preserves the storm limit.
    pre_start_service_id=$(discover_service_id)
    if [ "$pre_start_service_id" != "$service_id" ]; then
      configured=false
      service_id=
      control_status=unknown
      pre_start_status=service_changed
      next_count=0
      failure_kind=none
      action=start_cancelled
      reason=service_changed_before_start
      printf '%s\n' 'vpn-watchdog: reconnect cancelled after state change' >&2
    else
      pre_start_status=$(normalize_control_status "$service_id")
      if [ "$pre_start_status" != disconnected ]; then
        control_status=$pre_start_status
        next_count=0
        failure_kind=none
        action=start_cancelled
        reason=vpn_recovered_before_start
        printf '%s\n' 'vpn-watchdog: reconnect cancelled after state change' >&2
      else
        printf '%s\n' 'vpn-watchdog: reconnect start requested' >&2
        if "$scutil_bin" --nc start "$service_id" >/dev/null 2>&1; then
          action=start_requested
          reason=reconnect_requested
          if [ "$post_start_wait_seconds" -gt 0 ]; then
            "$sleep_bin" "$post_start_wait_seconds"
          fi
          post_start_status=$(normalize_control_status "$service_id")
          if [ "$post_start_status" = connected ]; then
            action=start_confirmed
            reason=reconnected
            next_count=0
            failure_kind=none
            printf '%s\n' 'vpn-watchdog: reconnect confirmed' >&2
          fi
        else
          action=start_failed
          reason=reconnect_command_failed
          printf '%s\n' 'vpn-watchdog: reconnect command failed' >&2
        fi
      fi
    fi
    if [ "$attempts_in_window" -ge "$max_attempts" ]; then
      printf '%s\n' 'vpn-watchdog: reconnect circuit opened' >&2
    fi
  fi
fi

service_json=null
if [ -n "$service_id" ]; then
  service_json="\"$service_id\""
fi

write_state_atomic

printf '{"version":1,"checkedAtEpoch":%s,"clockRollback":%s,"enabled":%s,"configured":%s,"bundleId":"%s","serviceId":%s,"controlStatus":"%s","afterProbeStatus":"%s","preStartStatus":"%s","postStartStatus":"%s","underlayStatus":"%s","consecutiveDisconnected":%s,"attemptsInWindow":%s,"lastAttemptEpoch":%s,"cooldownRemainingSeconds":%s,"circuitUntilEpoch":%s,"circuitRemainingSeconds":%s,"limits":{"failureSamples":%s,"cooldownSeconds":%s,"attemptWindowSeconds":%s,"maxAttempts":%s,"circuitSeconds":%s},"reason":"%s","action":"%s"}\n' \
  "$now_epoch" "$clock_rollback" "$enabled" "$configured" "$bundle_id" "$service_json" \
  "$control_status" "$after_probe_status" "$pre_start_status" "$post_start_status" "$underlay" "$next_count" \
  "$attempts_in_window" "$last_attempt" "$cooldown_remaining" "$circuit_until" \
  "$circuit_remaining" "$failure_samples" "$cooldown_seconds" \
  "$attempt_window_seconds" "$max_attempts" "$circuit_seconds" "$reason" "$action" \
  > "$report_tmp"
/bin/chmod 600 "$report_tmp"

/bin/mv -f "$report_tmp" "$report_file"
/bin/chmod 600 "$report_file"

exit 0

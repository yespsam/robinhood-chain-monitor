#!/bin/sh

set -eu

fail() {
  printf '%s\n' "not ok - $*" >&2
  exit 1
}

repo_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/../.." && /bin/pwd -P)
macos_dir="$repo_dir/deploy/macos"
fixture=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/robinhood-macos-watchdog.XXXXXX")
cleanup() {
  case "$fixture" in
    "${TMPDIR:-/tmp}"/robinhood-macos-watchdog.*) /bin/rm -rf -- "$fixture" ;;
    *) printf '%s\n' "refusing to remove unexpected fixture: $fixture" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$fixture/bin" "$fixture/data" "$fixture/state" "$fixture/fake" "$fixture/home"
: > "$fixture/actions.log"

cat > "$fixture/bin/launchctl" <<'EOF'
#!/bin/sh
set -eu
command=$1
shift
case "$command" in
  print)
    label=${1##*/}
    pid_file="$FAKE_STATE_DIR/$label.pid"
    [ -f "$pid_file" ] || exit 113
    printf 'gui/501/%s = {\n\tstate = running\n\tpid = %s\n}\n' "$label" "$(cat "$pid_file")"
    ;;
  kill)
    printf 'kill %s %s\n' "$1" "$2" >> "$FAKE_ACTIONS"
    if [ "${FAKE_GRACEFUL_EXIT:-false}" = true ]; then
      /bin/rm -f -- "$FAKE_STATE_DIR/${2##*/}.pid"
    fi
    ;;
  kickstart)
    printf 'kickstart %s\n' "$*" >> "$FAKE_ACTIONS"
    ;;
  *) exit 64 ;;
esac
EOF

cat > "$fixture/bin/kill" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = -0 ] || exit 64
for file in "$FAKE_STATE_DIR"/*.pid; do
  [ -f "$file" ] || continue
  [ "$(cat "$file")" = "$2" ] && exit 0
done
exit 1
EOF

cat > "$fixture/bin/scutil" <<'EOF'
#!/bin/sh
set -eu
case "${FAKE_NETWORK:-reachable}" in
  reachable) printf 'Reachable\n' ;;
  unreachable) printf 'Not Reachable\n' ;;
  *) printf 'Connection Required\n' ;;
esac
EOF

cat > "$fixture/bin/curl" <<'EOF'
#!/bin/sh
set -eu
[ "${FAKE_NETWORK:-reachable}" = reachable ]
EOF

cat > "$fixture/bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$fixture/bin/stat" <<'EOF'
#!/bin/sh
set -eu
path=${3-}
case "$path" in
  */fomo-runtime-heartbeat.json)
    printf '%s\n' "${WATCHDOG_NOW_EPOCH:?}"
    ;;
  *)
    /usr/bin/stat "$@"
    ;;
esac
EOF

chmod 700 "$fixture/bin/launchctl" "$fixture/bin/kill" "$fixture/bin/scutil" "$fixture/bin/curl" "$fixture/bin/sleep" "$fixture/bin/stat"
printf '31001\n' > "$fixture/fake/com.test.main.pid"
printf '31002\n' > "$fixture/fake/com.test.fomo.pid"
printf '{"version":1,"producer":"main","pid":31001}\n' > "$fixture/data/main-runtime-heartbeat.json"
printf '{"version":1,"producer":"fomo","pid":31002}\n' > "$fixture/data/fomo-runtime-heartbeat.json"
heartbeat_epoch=$(/usr/bin/stat -f '%m' "$fixture/data/main-runtime-heartbeat.json")
# Keep Fomo explicitly source-limited while the scenarios isolate main's stale
# counter and PID transitions. This also prevents its intentionally-future
# heartbeat fixture from becoming a second restart candidate.
/usr/bin/printf '%s\n' '{"sourceStatus":"source_limited"}' > "$fixture/data/fomo-health.json"
/usr/bin/touch -t 203501010000 "$fixture/data/fomo-runtime-heartbeat.json"

run_watchdog() {
  env \
    PROJECT_DIR="$repo_dir" \
    DATA_DIR="$fixture/data" \
    WATCHDOG_STATE_DIR="$fixture/state" \
    MAIN_LABEL=com.test.main \
    FOMO_LABEL=com.test.fomo \
    MAIN_HEARTBEAT="$fixture/data/main-runtime-heartbeat.json" \
    FOMO_HEARTBEAT="$fixture/data/fomo-runtime-heartbeat.json" \
    MAIN_HEALTH_REPORT="${MAIN_HEALTH_REPORT:-}" \
    FOMO_HEALTH_REPORT="$fixture/data/fomo-health.json" \
    WATCHDOG_NOW_EPOCH="$1" \
    WATCHDOG_LAUNCHCTL_BIN="$fixture/bin/launchctl" \
    WATCHDOG_KILL_BIN="$fixture/bin/kill" \
    WATCHDOG_SCUTIL_BIN="$fixture/bin/scutil" \
    WATCHDOG_CURL_BIN="$fixture/bin/curl" \
    WATCHDOG_SLEEP_BIN="$fixture/bin/sleep" \
    WATCHDOG_STAT_BIN="$fixture/bin/stat" \
    FAKE_STATE_DIR="$fixture/fake" \
    FAKE_ACTIONS="$fixture/actions.log" \
    FAKE_NETWORK="${2:-reachable}" \
    FAKE_GRACEFUL_EXIT="${FAKE_GRACEFUL_EXIT:-false}" \
    "$macos_dir/watchdog.sh"
}

run_watchdog "$((heartbeat_epoch + 30))"
[ ! -s "$fixture/actions.log" ] || fail "fresh heartbeats caused a restart"

run_watchdog "$((heartbeat_epoch + 121))"
[ ! -s "$fixture/actions.log" ] || fail "first stale sample caused a restart"
run_watchdog "$((heartbeat_epoch + 181))"
/usr/bin/grep -q '^kill SIGTERM gui/.*/com.test.main$' "$fixture/actions.log" || fail "second stale sample did not start a controlled restart"
/usr/bin/grep -q '^kickstart -k gui/.*/com.test.main$' "$fixture/actions.log" || fail "stuck PID did not fall back to kickstart -k"
first_action_count=$(/usr/bin/wc -l < "$fixture/actions.log" | /usr/bin/tr -d ' ')

run_watchdog "$((heartbeat_epoch + 242))"
run_watchdog "$((heartbeat_epoch + 303))"
second_action_count=$(/usr/bin/wc -l < "$fixture/actions.log" | /usr/bin/tr -d ' ')
[ "$first_action_count" = "$second_action_count" ] || fail "10 minute cooldown was not enforced"

# A clean SIGTERM followed by a plain kickstart must leave a valid report. The
# fake launchctl removes the old PID to exercise that branch explicitly.
rm -f "$fixture/state/state.tsv" "$fixture/actions.log"
: > "$fixture/actions.log"
printf '31001\n' > "$fixture/fake/com.test.main.pid"
run_watchdog "$((heartbeat_epoch + 121))"
FAKE_GRACEFUL_EXIT=true run_watchdog "$((heartbeat_epoch + 181))"
[ "$(/usr/bin/plutil -extract version raw -o - "$fixture/state/health.json" 2>/dev/null)" = 1 ] \
  || fail "graceful-exit kickstart wrote a malformed report"
/usr/bin/grep -q '^kickstart gui/.*/com.test.main$' "$fixture/actions.log" || fail "graceful exit did not use plain kickstart"
printf '31001\n' > "$fixture/fake/com.test.main.pid"

# A small explicit source-limited report must suppress stale-heartbeat restarts.
rm -f "$fixture/state/state.tsv" "$fixture/actions.log"
: > "$fixture/actions.log"
printf '{"sourceStatus":"source_limited"}\n' > "$fixture/data/main-health.json"
/usr/bin/touch -t 203501010000 "$fixture/data/main-health.json"
MAIN_HEALTH_REPORT="$fixture/data/main-health.json" \
  run_watchdog "$((heartbeat_epoch + 500))"
MAIN_HEALTH_REPORT="$fixture/data/main-health.json" \
  run_watchdog "$((heartbeat_epoch + 560))"
[ ! -s "$fixture/actions.log" ] || fail "source_limited caused a restart"
MAIN_HEALTH_REPORT=
/bin/rm -f -- "$fixture/data/main-health.json"

# A heartbeat mtime far in the future is invalid rather than fresh. Two
# observations must therefore trigger the normal forced kickstart path.
rm -f "$fixture/state/state.tsv" "$fixture/actions.log"
: > "$fixture/actions.log"
printf '31001\n' > "$fixture/fake/com.test.main.pid"
/usr/bin/touch -t 203501010000 "$fixture/data/main-runtime-heartbeat.json"
FAKE_GRACEFUL_EXIT=false run_watchdog "$heartbeat_epoch"
[ ! -s "$fixture/actions.log" ] || fail "first future-mtime sample caused a restart"
FAKE_GRACEFUL_EXIT=false run_watchdog "$heartbeat_epoch"
/usr/bin/grep -q '^kickstart -k gui/.*/com.test.main$' "$fixture/actions.log" \
  || fail "future heartbeat mtime was allowed to mask a frozen process"
/usr/bin/touch -t 203501010000 "$fixture/data/fomo-runtime-heartbeat.json"
: > "$fixture/actions.log"

for protected_status in degraded partial; do
  printf '{"sourceStatus":"%s"}\n' "$protected_status" > "$fixture/data/main-health.json"
  /usr/bin/touch -t 203501010000 "$fixture/data/main-health.json"
  MAIN_HEALTH_REPORT="$fixture/data/main-health.json" \
    run_watchdog "$((heartbeat_epoch + 620))"
  MAIN_HEALTH_REPORT="$fixture/data/main-health.json" \
    run_watchdog "$((heartbeat_epoch + 680))"
  [ ! -s "$fixture/actions.log" ] || fail "$protected_status caused a restart"
done
MAIN_HEALTH_REPORT=

# Network uncertainty also suppresses a restart even when both heartbeats age.
rm -f "$fixture/state/state.tsv"
run_watchdog "$((heartbeat_epoch + 700))" unreachable
run_watchdog "$((heartbeat_epoch + 760))" unreachable
[ ! -s "$fixture/actions.log" ] || fail "network outage caused a restart"

# Missing processes are still repaired after two observations; launchd itself
# normally handles this sooner, so this is only the independent fallback.
rm -f "$fixture/state/state.tsv" "$fixture/fake/com.test.main.pid"
run_watchdog "$((heartbeat_epoch + 800))" unreachable
run_watchdog "$((heartbeat_epoch + 860))" unreachable
[ ! -s "$fixture/actions.log" ] || fail "offline missing process caused a restart"
rm -f "$fixture/state/state.tsv"
run_watchdog "$((heartbeat_epoch + 800))"
[ ! -s "$fixture/actions.log" ] || fail "first missing-process sample caused a restart"
run_watchdog "$((heartbeat_epoch + 860))"
/usr/bin/grep -q '^kickstart gui/.*/com.test.main$' "$fixture/actions.log" || fail "missing process was not kickstarted"

[ "$(/usr/bin/plutil -extract version raw -o - "$fixture/state/health.json" 2>/dev/null)" = 1 ] \
  || fail "watchdog report is invalid JSON"

# Exercise real installer generation in an isolated HOME without loading units.
HOME="$fixture/home" "$macos_dir/install.sh" --project-dir "$repo_dir" --no-load >/dev/null
sleep_plist="$fixture/home/Library/LaunchAgents/com.qohfq.robinhood-ac-sleep-guard.plist"
watchdog_plist="$fixture/home/Library/LaunchAgents/com.qohfq.robinhood-local-watchdog.plist"
/usr/bin/plutil -lint "$sleep_plist" "$watchdog_plist" >/dev/null || fail "generated plist failed lint"
[ "$(/usr/bin/stat -f '%Lp' "$sleep_plist")" = 600 ] || fail "sleep plist permissions are not 0600"
[ "$(/usr/bin/stat -f '%Lp' "$watchdog_plist")" = 600 ] || fail "watchdog plist permissions are not 0600"
/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$sleep_plist" | /usr/bin/grep -qx /usr/bin/caffeinate \
  || fail "sleep guard does not use system caffeinate"
/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$sleep_plist" | /usr/bin/grep -qx -- -s \
  || fail "sleep guard is not AC-only (-s)"
/usr/bin/plutil -extract EnvironmentVariables.MAIN_HEARTBEAT raw -o - "$watchdog_plist" \
  | /usr/bin/grep -qx "$repo_dir/data/main-runtime-heartbeat.json" \
  || fail "watchdog does not use the main producer-owned runtime heartbeat"
/usr/bin/plutil -extract EnvironmentVariables.FOMO_HEARTBEAT raw -o - "$watchdog_plist" \
  | /usr/bin/grep -qx "$repo_dir/data/fomo-runtime-heartbeat.json" \
  || fail "watchdog does not use the Fomo producer-owned runtime heartbeat"
HOME="$fixture/home" "$macos_dir/install.sh" --uninstall --no-load >/dev/null
[ ! -e "$sleep_plist" ] || fail "uninstall left the sleep plist"
[ ! -e "$watchdog_plist" ] || fail "uninstall left the watchdog plist"

/bin/bash -n "$macos_dir/install.sh" "$macos_dir/watchdog.sh" "$macos_dir/test-offline.sh"
/bin/zsh -n "$macos_dir/install.sh" "$macos_dir/watchdog.sh" "$macos_dir/test-offline.sh"

printf '%s\n' "ok - macOS sleep guard/watchdog offline fixtures"

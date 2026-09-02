#!/bin/sh

set -eu

fail() {
  printf '%s\n' "not ok - $*" >&2
  exit 1
}

repo_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/../.." && /bin/pwd -P)
macos_dir="$repo_dir/deploy/macos"
fixture=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/robinhood-vpn-watchdog.XXXXXX")
cleanup() {
  case "$fixture" in
    "${TMPDIR:-/tmp}"/robinhood-vpn-watchdog.*) /bin/rm -rf -- "$fixture" ;;
    *) printf '%s\n' "refusing to remove unexpected fixture: $fixture" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

/bin/mkdir -p "$fixture/bin" "$fixture/state" "$fixture/fake" "$fixture/home"
: > "$fixture/actions.log"

service_id=4CC0CACF-B97D-463C-8863-81DC71263A5E

cat > "$fixture/bin/scutil" <<'EOF'
#!/bin/sh
set -eu
[ "${1-}" = --nc ] || exit 64
command=${2-}
case "$command" in
  list)
    printf '%s\n' 'scutil list' >> "$FAKE_ACTIONS"
    list_count_file="$FAKE_STATE_DIR/list-count"
    list_count=$(cat "$list_count_file" 2>/dev/null || printf '0')
    list_count=$((list_count + 1))
    printf '%s\n' "$list_count" > "$list_count_file"
    list_service_id=$FAKE_SERVICE_ID
    if [ "$list_count" -ge 2 ] && [ -n "${FAKE_SECOND_DISCOVERY_ID:-}" ]; then
      list_service_id=$FAKE_SECOND_DISCOVERY_ID
    fi
    case "${FAKE_SERVICE_LAYOUT:-unique}" in
      unique)
        printf 'Available network connection services in the current set (*=enabled):\n'
        printf '* (%s)      %s VPN (com.vpn.cat)  "VPN cat" [VPN:com.vpn.cat]\n' \
          "$(cat "$FAKE_STATE_DIR/control-status")" "$list_service_id"
        ;;
      duplicate)
        printf '* (Disconnected)      %s VPN (com.vpn.cat) "VPN cat A" [VPN:com.vpn.cat]\n' "$FAKE_SERVICE_ID"
        printf '* (Disconnected)      5DD0CACF-B97D-463C-8863-81DC71263A5F VPN (com.vpn.cat) "VPN cat B" [VPN:com.vpn.cat]\n'
        ;;
      disabled)
        printf '  (Disconnected)      %s VPN (com.vpn.cat) "VPN cat" [VPN:com.vpn.cat]\n' "$FAKE_SERVICE_ID"
        ;;
      wrong_bundle)
        printf '* (Disconnected)      %s VPN (example.invalid) "Other VPN" [VPN:example.invalid]\n' "$FAKE_SERVICE_ID"
        ;;
      decoy_marker)
        printf '* (Disconnected)      %s VPN (example.invalid) "Decoy [VPN:com.vpn.cat]" [VPN:example.invalid]\n' "$FAKE_SERVICE_ID"
        ;;
      missing) printf '%s\n' 'Available network connection services in the current set (*=enabled):' ;;
      malformed) printf '%s\n' '* (Disconnected) not-a-uuid VPN (com.vpn.cat) "VPN cat" [VPN:com.vpn.cat]' ;;
      *) exit 65 ;;
    esac
    ;;
  status)
    [ "${3-}" = "$FAKE_SERVICE_ID" ] || exit 66
    printf '%s\n' 'scutil status' >> "$FAKE_ACTIONS"
    cat "$FAKE_STATE_DIR/control-status"
    ;;
  start)
    [ "${3-}" = "$FAKE_SERVICE_ID" ] || exit 67
    printf '%s\n' 'scutil start' >> "$FAKE_ACTIONS"
    if [ "${FAKE_CRASH_AFTER_START:-false}" = true ]; then
      /bin/kill -KILL "$PPID"
      /bin/sleep 1
      exit 72
    fi
    if [ "${FAKE_START_FAIL:-false}" = true ]; then
      exit 1
    fi
    printf '%s\n' "${FAKE_START_STATUS:-Connecting}" > "$FAKE_STATE_DIR/control-status"
    ;;
  stop)
    printf '%s\n' 'scutil stop' >> "$FAKE_ACTIONS"
    exit 68
    ;;
  *) exit 64 ;;
esac
EOF

cat > "$fixture/bin/curl" <<'EOF'
#!/bin/sh
set -eu
[ "${1-}" = --disable ] || exit 73
last=
interface=
previous=
for argument in "$@"; do
  if [ "$previous" = --interface ]; then
    interface=$argument
  fi
  previous=$argument
  last=$argument
done
[ "$interface" = "${FAKE_ROUTE_INTERFACE:-en0}" ] || exit 69
case "$last" in
  "$FAKE_PRIMARY_URL") probe=primary; result=${FAKE_PRIMARY_RESULT:-success} ;;
  "$FAKE_SECONDARY_URL") probe=secondary; result=${FAKE_SECONDARY_RESULT:-success} ;;
  *) exit 70 ;;
esac
printf 'curl %s\n' "$probe" >> "$FAKE_ACTIONS"
if [ -n "${FAKE_CURL_STATUS_AFTER:-}" ]; then
  printf '%s\n' "$FAKE_CURL_STATUS_AFTER" > "$FAKE_STATE_DIR/control-status"
fi
case "$result" in
  success|http403|http429|http500) exit 0 ;;
  fail) exit 28 ;;
  *) exit 71 ;;
esac
EOF

cat > "$fixture/bin/route" <<'EOF'
#!/bin/sh
set -eu
[ "$*" = '-n get default' ] || exit 64
printf '%s\n' 'route get' >> "$FAKE_ACTIONS"
case "${FAKE_ROUTE_INTERFACE:-en0}" in
  none) printf '%s\n' 'route: writing to routing socket: not in table'; exit 1 ;;
  *) printf '   route to: default\ninterface: %s\n' "$FAKE_ROUTE_INTERFACE" ;;
esac
EOF

cat > "$fixture/bin/kill" <<'EOF'
#!/bin/sh
set -eu
[ "${1-}" = -0 ] || exit 64
[ "${FAKE_LOCK_ALIVE:-false}" = true ]
EOF

cat > "$fixture/bin/date" <<'EOF'
#!/bin/sh
set -eu
[ "${1-}" = +%s ] || exit 64
printf '%s\n' 'date now' >> "$FAKE_ACTIONS"
printf '%s\n' "${FAKE_NOW:?FAKE_NOW is required}"
EOF

cat > "$fixture/bin/sleep" <<'EOF'
#!/bin/sh
set -eu
printf 'sleep %s\n' "${1-}" >> "$FAKE_ACTIONS"
EOF

cat > "$fixture/bin/sync" <<'EOF'
#!/bin/sh
set -eu
[ "$#" -eq 0 ] || exit 64
printf '%s\n' 'sync state' >> "$FAKE_ACTIONS"
if [ -n "${FAKE_SYNC_STATUS_AFTER:-}" ]; then
  printf '%s\n' "$FAKE_SYNC_STATUS_AFTER" > "$FAKE_STATE_DIR/control-status"
fi
EOF

/bin/chmod 700 "$fixture/bin/scutil" "$fixture/bin/curl" "$fixture/bin/route" \
  "$fixture/bin/kill" "$fixture/bin/date" "$fixture/bin/sleep" "$fixture/bin/sync"

primary_url=https://fixture.invalid/primary
secondary_url=https://fixture.invalid/secondary

reset_fixture() {
  unset VPN_WATCHDOG_ENABLED VPN_WATCHDOG_BUNDLE_ID
  unset FAKE_SERVICE_LAYOUT FAKE_ROUTE_INTERFACE FAKE_PRIMARY_RESULT FAKE_SECONDARY_RESULT
  unset FAKE_START_STATUS FAKE_START_FAIL FAKE_CRASH_AFTER_START FAKE_LOCK_ALIVE
  unset FAKE_CURL_STATUS_AFTER FAKE_SECOND_DISCOVERY_ID
  unset FAKE_SYNC_STATUS_AFTER
  /bin/rm -rf -- "$fixture/state"
  /bin/mkdir -p "$fixture/state"
  : > "$fixture/actions.log"
  printf '%s\n' Connected > "$fixture/fake/control-status"
  printf '%s\n' 0 > "$fixture/fake/list-count"
}

run_vpn() {
  env \
    VPN_WATCHDOG_ENABLED="${VPN_WATCHDOG_ENABLED:-true}" \
    VPN_WATCHDOG_BUNDLE_ID="${VPN_WATCHDOG_BUNDLE_ID:-com.vpn.cat}" \
    VPN_WATCHDOG_STATE_DIR="$fixture/state" \
    VPN_WATCHDOG_FAILURE_SAMPLES=2 \
    VPN_WATCHDOG_COOLDOWN_SECONDS=600 \
    VPN_WATCHDOG_ATTEMPT_WINDOW_SECONDS=3600 \
    VPN_WATCHDOG_MAX_ATTEMPTS=3 \
    VPN_WATCHDOG_CIRCUIT_SECONDS=3600 \
    VPN_WATCHDOG_POST_START_WAIT_SECONDS=2 \
    VPN_WATCHDOG_UNDERLAY_URL_PRIMARY="$primary_url" \
    VPN_WATCHDOG_UNDERLAY_URL_SECONDARY="$secondary_url" \
    VPN_WATCHDOG_SCUTIL_BIN="$fixture/bin/scutil" \
    VPN_WATCHDOG_CURL_BIN="$fixture/bin/curl" \
    VPN_WATCHDOG_ROUTE_BIN="$fixture/bin/route" \
    VPN_WATCHDOG_KILL_BIN="$fixture/bin/kill" \
    VPN_WATCHDOG_DATE_BIN="$fixture/bin/date" \
    VPN_WATCHDOG_SLEEP_BIN="$fixture/bin/sleep" \
    VPN_WATCHDOG_SYNC_BIN="$fixture/bin/sync" \
    FAKE_NOW="$1" \
    FAKE_ACTIONS="$fixture/actions.log" \
    FAKE_STATE_DIR="$fixture/fake" \
    FAKE_SERVICE_ID="$service_id" \
    FAKE_SERVICE_LAYOUT="${FAKE_SERVICE_LAYOUT:-unique}" \
    FAKE_ROUTE_INTERFACE="${FAKE_ROUTE_INTERFACE:-en0}" \
    FAKE_PRIMARY_URL="$primary_url" \
    FAKE_SECONDARY_URL="$secondary_url" \
    FAKE_PRIMARY_RESULT="${FAKE_PRIMARY_RESULT:-success}" \
    FAKE_SECONDARY_RESULT="${FAKE_SECONDARY_RESULT:-success}" \
    FAKE_START_STATUS="${FAKE_START_STATUS:-Connecting}" \
    FAKE_START_FAIL="${FAKE_START_FAIL:-false}" \
    FAKE_CRASH_AFTER_START="${FAKE_CRASH_AFTER_START:-false}" \
    FAKE_LOCK_ALIVE="${FAKE_LOCK_ALIVE:-false}" \
    FAKE_CURL_STATUS_AFTER="${FAKE_CURL_STATUS_AFTER:-}" \
    FAKE_SECOND_DISCOVERY_ID="${FAKE_SECOND_DISCOVERY_ID:-}" \
    FAKE_SYNC_STATUS_AFTER="${FAKE_SYNC_STATUS_AFTER:-}" \
    "$macos_dir/vpn-watchdog.sh"
}

health_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$fixture/state/health.json" 2>/dev/null
}

action_count() {
  /usr/bin/grep -c '^scutil start$' "$fixture/actions.log" 2>/dev/null || true
}

# Default-enabled, connected service: report only. Application/RPC/Telegram
# failures are deliberately outside this watchdog and curl is not called.
reset_fixture
FAKE_PRIMARY_RESULT=fail FAKE_SECONDARY_RESULT=fail run_vpn 2000000000
[ "$(health_value enabled)" = true ] || fail "VPN watchdog is not enabled by default"
[ "$(health_value configured)" = true ] || fail "unique enabled VPN cat service was not configured"
[ "$(health_value controlStatus)" = connected ] || fail "connected control state was not reported"
[ "$(action_count)" = 0 ] || fail "connected VPN was restarted"
! /usr/bin/grep -q '^curl ' "$fixture/actions.log" || fail "connected VPN performed an application-path probe"

# Operators can explicitly disable the independent unit without affecting the
# production process watchdog. Disabled mode does not even enumerate services.
reset_fixture
VPN_WATCHDOG_ENABLED=false run_vpn 2000000010
[ "$(health_value enabled)" = false ] || fail "disabled state was not reported"
[ "$(health_value reason)" = disabled ] || fail "disabled state has the wrong reason"
! /usr/bin/grep -q '^scutil ' "$fixture/actions.log" || fail "disabled watchdog called scutil"

# Discovery is exact and fail-closed: duplicate, disabled, wrong-bundle,
# missing, or malformed entries cannot be selected.
for layout in duplicate disabled wrong_bundle decoy_marker missing malformed; do
  reset_fixture
  FAKE_SERVICE_LAYOUT="$layout" run_vpn 2000000030
  [ "$(health_value configured)" = false ] || fail "$layout VPN layout was accepted"
  [ "$(health_value reason)" = not_configured ] || fail "$layout did not report not_configured"
  [ "$(action_count)" = 0 ] || fail "$layout caused a reconnect"
done

# Disconnected plus a real non-tunnel route and successful HTTPS transport
# must be seen twice. The second observation starts only the discovered UUID.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_STATUS=Disconnected run_vpn 2000000100
[ "$(health_value consecutiveDisconnected)" = 1 ] || fail "first qualified disconnect was not counted"
[ "$(action_count)" = 0 ] || fail "first disconnect reconnected too early"
FAKE_START_STATUS=Disconnected run_vpn 2000000130
[ "$(action_count)" = 1 ] || fail "second qualified disconnect did not reconnect"
[ "$(health_value action)" = start_requested ] || fail "successful start request was not reported"
[ "$(health_value cooldownRemainingSeconds)" = 600 ] || fail "reconnect cooldown did not start"
/usr/bin/grep -q '^sleep 2$' "$fixture/actions.log" || fail "post-start verification did not use injected sleep"
FAKE_START_STATUS=Disconnected run_vpn 2000000160
[ "$(action_count)" = 1 ] || fail "cooldown allowed a reconnect storm"
[ "$(health_value reason)" = cooldown ] || fail "cooldown was not reported"

# Re-discovery and status confirmation close the probe TOCTOU window. A VPN
# that self-recovers, disappears, or is replaced while curl runs is not counted
# and never receives a stale start request.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_CURL_STATUS_AFTER=Connected run_vpn 2000000180
[ "$(health_value reason)" = vpn_recovered_during_probe ] || fail "probe-time recovery was not reported"
[ "$(health_value consecutiveDisconnected)" = 0 ] || fail "probe-time recovery accumulated a failure"
[ "$(action_count)" = 0 ] || fail "probe-time recovery received a stale start"
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_SECOND_DISCOVERY_ID=5DD0CACF-B97D-463C-8863-81DC71263A5F run_vpn 2000000190
[ "$(health_value configured)" = false ] || fail "provider replacement remained configured"
[ "$(health_value reason)" = service_changed_during_probe ] || fail "provider replacement was not reported"
[ "$(health_value consecutiveDisconnected)" = 0 ] || fail "provider replacement accumulated a failure"
[ "$(action_count)" = 0 ] || fail "provider replacement received a stale start"

# Even the durability barrier may take time. If the VPN recovers during sync,
# consume the conservative reservation but cancel before calling scutil start.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_STATUS=Disconnected run_vpn 2000000195
FAKE_SYNC_STATUS_AFTER=Connected FAKE_START_STATUS=Disconnected run_vpn 2000000196
[ "$(health_value action)" = start_cancelled ] || fail "sync-time recovery did not cancel start"
[ "$(health_value reason)" = vpn_recovered_before_start ] || fail "sync-time recovery reason is wrong"
[ "$(health_value attemptsInWindow)" = 1 ] || fail "cancelled durable reservation was not consumed"
[ "$(action_count)" = 0 ] || fail "sync-time recovery received a stale start"

# A valid 403/429/5xx response is connectivity, not an upstream failure.
for http_result in http403 http429 http500; do
  reset_fixture
  printf '%s\n' Disconnected > "$fixture/fake/control-status"
  FAKE_PRIMARY_RESULT="$http_result" FAKE_START_STATUS=Disconnected run_vpn 2000000200
  FAKE_PRIMARY_RESULT="$http_result" FAKE_START_STATUS=Disconnected run_vpn 2000000230
  [ "$(action_count)" = 1 ] || fail "$http_result was mistaken for underlay failure"
  ! /usr/bin/grep -q '^curl secondary$' "$fixture/actions.log" \
    || fail "fallback probe ran after reachable $http_result"
done

# Both underlay probes failing, or a virtual/default route, suppresses action
# and does not accumulate qualified disconnect samples.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_PRIMARY_RESULT=fail FAKE_SECONDARY_RESULT=fail run_vpn 2000000300
FAKE_PRIMARY_RESULT=fail FAKE_SECONDARY_RESULT=fail run_vpn 2000000330
[ "$(health_value underlayStatus)" = unreachable ] || fail "failed underlay was not reported"
[ "$(health_value consecutiveDisconnected)" = 0 ] || fail "offline samples accumulated reconnect evidence"
[ "$(action_count)" = 0 ] || fail "underlay outage caused reconnect"
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_ROUTE_INTERFACE=utun4 run_vpn 2000000360
[ "$(health_value underlayStatus)" = unknown ] || fail "tunnel route was accepted as physical underlay"
[ "$(action_count)" = 0 ] || fail "unknown underlay caused reconnect"

# NetworkExtension transitions are left alone and never run underlay probes.
for transition in Connecting Disconnecting Reasserting; do
  reset_fixture
  printf '%s\n' "$transition" > "$fixture/fake/control-status"
  run_vpn 2000000400
  [ "$(action_count)" = 0 ] || fail "$transition caused reconnect"
  ! /usr/bin/grep -q '^route get$' "$fixture/actions.log" || fail "$transition probed the underlay"
done

# A failed start still starts cooldown. It cannot retry on every 30-second run.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_FAIL=true run_vpn 2000000500
FAKE_START_FAIL=true run_vpn 2000000530
[ "$(health_value action)" = start_failed ] || fail "failed start was not reported"
FAKE_START_FAIL=true run_vpn 2000000560
[ "$(action_count)" = 1 ] || fail "failed start bypassed cooldown"

# The attempt/cooldown reservation is durable before scutil executes. Simulate
# an untrappable crash immediately after the fake command records `start`; the
# next invocation must consume the persisted attempt and remain in cooldown.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_STATUS=Disconnected run_vpn 2000000600
crash_log="$fixture/crash-after-start.log"
if (FAKE_CRASH_AFTER_START=true FAKE_START_STATUS=Disconnected run_vpn 2000000630) \
  > /dev/null 2> "$crash_log"; then
  fail "crash-after-start fixture unexpectedly completed"
fi
[ "$(action_count)" = 1 ] || fail "crash fixture did not issue exactly one start"
/usr/bin/grep -q '^sync state$' "$fixture/actions.log" || fail "attempt reservation lacked durability barrier"
FAKE_START_STATUS=Disconnected run_vpn 2000000660
[ "$(action_count)" = 1 ] || fail "crash lost cooldown and repeated start"
[ "$(health_value attemptsInWindow)" = 1 ] || fail "crash lost reserved attempt"
[ "$(health_value reason)" = cooldown ] || fail "crash recovery did not report cooldown"

# A backwards wall clock cannot clear cooldown/rate limits or issue another
# start. The prior high-water observation remains in durable state.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_STATUS=Disconnected run_vpn 2000000700
FAKE_START_STATUS=Disconnected run_vpn 2000000730
FAKE_START_STATUS=Disconnected run_vpn 2000000600
[ "$(action_count)" = 1 ] || fail "clock rollback issued another reconnect"
[ "$(health_value clockRollback)" = true ] || fail "clock rollback was not reported"
[ "$(health_value reason)" = clock_rollback ] || fail "clock rollback did not fail closed"
[ "$(health_value attemptsInWindow)" = 1 ] || fail "clock rollback cleared attempt history"

# Attempts remain bounded across a fixed-hour boundary. Two attempts near
# opposite sides of that boundary plus a third must open the rolling circuit.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_STATUS=Disconnected run_vpn 3000000000
FAKE_START_STATUS=Disconnected run_vpn 3000000030
FAKE_START_STATUS=Disconnected run_vpn 3000003030
FAKE_START_STATUS=Disconnected run_vpn 3000003630
[ "$(action_count)" = 3 ] || fail "cross-boundary setup did not consume three attempts"
[ "$(health_value circuitRemainingSeconds)" = 3600 ] || fail "cross-boundary third attempt did not open circuit"
FAKE_START_STATUS=Disconnected run_vpn 3000004230
[ "$(action_count)" = 3 ] || fail "fixed-window boundary allowed a fourth rolling-hour attempt"

# At most three start attempts are allowed; the third opens a full one-hour
# circuit. Expiry clears the attempt window and permits recovery again.
reset_fixture
printf '%s\n' Disconnected > "$fixture/fake/control-status"
FAKE_START_STATUS=Disconnected run_vpn 2000001000
FAKE_START_STATUS=Disconnected run_vpn 2000001030
FAKE_START_STATUS=Disconnected run_vpn 2000001630
FAKE_START_STATUS=Disconnected run_vpn 2000002230
[ "$(action_count)" = 3 ] || fail "did not perform exactly three hourly attempts"
[ "$(health_value circuitRemainingSeconds)" = 3600 ] || fail "third attempt did not open one-hour circuit"
FAKE_START_STATUS=Disconnected run_vpn 2000002830
[ "$(action_count)" = 3 ] || fail "open circuit allowed a fourth attempt"
[ "$(health_value reason)" = circuit_open ] || fail "open circuit was not reported"
FAKE_START_STATUS=Disconnected run_vpn 2000005829
[ "$(action_count)" = 3 ] || fail "circuit expired early"
FAKE_START_STATUS=Disconnected run_vpn 2000005830
[ "$(action_count)" = 4 ] || fail "expired circuit did not permit recovery"

# A live lock owner makes a concurrent invocation exit before discovery/action.
reset_fixture
/bin/mkdir "$fixture/state/run.lock"
printf '%s\n' 4242 > "$fixture/state/run.lock/owner"
FAKE_LOCK_ALIVE=true run_vpn 2000006000
[ ! -e "$fixture/state/health.json" ] || fail "concurrent invocation overwrote health"
[ "$(action_count)" = 0 ] || fail "concurrent invocation performed an action"
/bin/rm -f "$fixture/state/run.lock/owner"
/bin/rmdir "$fixture/state/run.lock"

# A stale lock is recovered after the injected liveness check rejects its PID.
/bin/mkdir "$fixture/state/run.lock"
printf '%s\n' 4242 > "$fixture/state/run.lock/owner"
FAKE_LOCK_ALIVE=false run_vpn 2000006010
[ "$(health_value controlStatus)" = connected ] || fail "stale lock was not safely recovered"

# State and report are private, valid, and atomically leave no temporary files.
printf '%s\n' Connected > "$fixture/fake/control-status"
run_vpn 2000006030
[ "$(/usr/bin/stat -f '%Lp' "$fixture/state/state.tsv")" = 600 ] || fail "state permissions are not 0600"
[ "$(/usr/bin/stat -f '%Lp' "$fixture/state/health.json")" = 600 ] || fail "health permissions are not 0600"
[ "$(/usr/bin/stat -f '%Lp' "$fixture/state")" = 700 ] || fail "state directory permissions are not 0700"
[ "$(health_value version)" = 1 ] || fail "health report is invalid JSON"
[ -z "$(/usr/bin/find "$fixture/state" -maxdepth 1 -name '.*.tmp' -print)" ] || fail "atomic temporary files were left behind"
/usr/bin/grep -q '^date now$' "$fixture/actions.log" || fail "injected date command was not used"

# Reject shell metacharacters and newlines in the configured bundle ID before
# discovery. Values are passed literally; no marker command may execute.
marker="$fixture/bundle-injection-marker"
bad_newline=$(printf 'com.vpn.cat\nmalicious')
bad_command="com.vpn.cat\$(touch $marker)"
for bad_bundle in 'com.vpn.cat;invalid' "$bad_command" "$bad_newline"; do
  reset_fixture
  if VPN_WATCHDOG_BUNDLE_ID="$bad_bundle" run_vpn 2000006060 >/dev/null 2>&1; then
    fail "malicious bundle ID was accepted"
  fi
  [ ! -e "$marker" ] || fail "malicious bundle ID created a marker"
  ! /usr/bin/grep -q '^scutil ' "$fixture/actions.log" || fail "malicious bundle ID reached scutil"
done

# Exercise the real installer in an isolated HOME. It must add exactly the
# independent third agent and leave the production worker plists untouched.
/bin/mkdir -p "$fixture/home/Library/LaunchAgents"
main_production_plist="$fixture/home/Library/LaunchAgents/com.qohfq.robinhood-launchpad-monitor.plist"
fomo_production_plist="$fixture/home/Library/LaunchAgents/com.qohfq.fomo-call-monitor.plist"
printf '%s\n' 'production-main-sentinel' > "$main_production_plist"
printf '%s\n' 'production-fomo-sentinel' > "$fomo_production_plist"
production_hash_before=$(/usr/bin/shasum -a 256 "$main_production_plist" "$fomo_production_plist")
production_mtime_before=$(/usr/bin/stat -f '%m:%N' "$main_production_plist" "$fomo_production_plist")
HOME="$fixture/home" "$macos_dir/install.sh" --project-dir "$repo_dir" --no-load >/dev/null
vpn_plist="$fixture/home/Library/LaunchAgents/com.qohfq.robinhood-vpn-watchdog.plist"
vpn_install="$fixture/home/Library/Application Support/robinhood-chain-monitor/bin/vpn-watchdog.sh"
/usr/bin/plutil -lint "$vpn_plist" >/dev/null || fail "generated VPN plist failed lint"
[ "$(/usr/bin/stat -f '%Lp' "$vpn_plist")" = 600 ] || fail "VPN plist permissions are not 0600"
[ "$(/usr/bin/stat -f '%Lp' "$vpn_install")" = 700 ] || fail "installed VPN script permissions are not 0700"
[ "$(/usr/bin/plutil -extract Label raw -o - "$vpn_plist")" = com.qohfq.robinhood-vpn-watchdog ] \
  || fail "VPN LaunchAgent label is wrong"
[ "$(/usr/bin/plutil -extract StartInterval raw -o - "$vpn_plist")" = 30 ] \
  || fail "VPN LaunchAgent interval is not 30 seconds"
[ "$(/usr/bin/plutil -extract RunAtLoad raw -o - "$vpn_plist")" = true ] \
  || fail "VPN LaunchAgent is not configured to run at load"
[ "$(/usr/bin/plutil -extract EnvironmentVariables.VPN_WATCHDOG_ENABLED raw -o - "$vpn_plist")" = true ] \
  || fail "installed VPN watchdog is not enabled by default"
[ "$(/usr/bin/plutil -extract EnvironmentVariables.VPN_WATCHDOG_BUNDLE_ID raw -o - "$vpn_plist")" = com.vpn.cat ] \
  || fail "installed VPN watchdog bundle ID is wrong"
production_hash_after=$(/usr/bin/shasum -a 256 "$main_production_plist" "$fomo_production_plist")
production_mtime_after=$(/usr/bin/stat -f '%m:%N' "$main_production_plist" "$fomo_production_plist")
[ "$production_hash_before" = "$production_hash_after" ] || fail "installer changed a production worker plist"
[ "$production_mtime_before" = "$production_mtime_after" ] || fail "installer touched a production worker plist"
HOME="$fixture/home" "$macos_dir/install.sh" --uninstall --no-load >/dev/null
[ ! -e "$vpn_plist" ] || fail "uninstall left the VPN plist"
[ ! -e "$vpn_install" ] || fail "uninstall left the VPN script"

! /usr/bin/grep -Eq '\$scutil_bin.*--nc[[:space:]]+stop|scutil_bin.*--nc[[:space:]]+stop' \
  "$macos_dir/vpn-watchdog.sh" || fail "VPN watchdog contains a stop operation"

/bin/bash -n "$macos_dir/vpn-watchdog.sh" "$macos_dir/test-vpn-offline.sh" "$macos_dir/install.sh"
/bin/zsh -n "$macos_dir/vpn-watchdog.sh" "$macos_dir/test-vpn-offline.sh" "$macos_dir/install.sh"

printf '%s\n' 'ok - independent VPN cat watchdog offline fixtures'

#!/bin/sh

# Install only the local AC sleep guard and independent watchdog LaunchAgents.
# Existing production monitor LaunchAgents are never edited by this installer.

set -eu

umask 077

usage() {
  cat <<'EOF'
Usage: deploy/macos/install.sh [--dry-run] [--no-load] [--project-dir PATH]
       deploy/macos/install.sh --uninstall [--dry-run] [--no-load]

  --dry-run       Print exact managed paths and generated plists; write nothing.
  --no-load       Install/remove files without bootstrap/bootout operations.
  --project-dir   Absolute or relative project directory (default: repository root).
  --uninstall     Remove only files and LaunchAgents managed by this installer.
EOF
}

die() {
  printf '%s\n' "macOS installer: $*" >&2
  exit 1
}

xml_escape() {
  printf '%s' "$1" | /usr/bin/sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

dry_run=false
no_load=false
uninstall=false
project_arg=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --no-load) no_load=true ;;
    --uninstall) uninstall=true ;;
    --project-dir)
      [ "$#" -ge 2 ] || die "--project-dir requires a path"
      shift
      project_arg=$1
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

[ "$(/usr/bin/id -u)" -ne 0 ] || die "run as the login user, not root"
[ "$(/usr/bin/uname -s)" = Darwin ] || die "this installer supports macOS only"

script_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd -P)
default_project=$(CDPATH= cd -- "$script_dir/../.." && /bin/pwd -P)
if [ -n "$project_arg" ]; then
  [ -d "$project_arg" ] || die "project directory does not exist: $project_arg"
  project_dir=$(CDPATH= cd -- "$project_arg" && /bin/pwd -P)
else
  project_dir=$default_project
fi
[ -f "$project_dir/src/index.js" ] || die "project directory is missing src/index.js"
[ -f "$project_dir/src/fomo-worker.js" ] || die "project directory is missing src/fomo-worker.js"

home_dir=${HOME:?HOME is required}
case "$home_dir" in ''|/) die "HOME is unsafe" ;; esac

agent_dir="$home_dir/Library/LaunchAgents"
support_dir="$home_dir/Library/Application Support/robinhood-chain-monitor"
bin_dir="$support_dir/bin"
state_dir="$support_dir/watchdog"
log_dir="$project_dir/data/logs"
watchdog_install="$bin_dir/watchdog.sh"
sleep_label=com.qohfq.robinhood-ac-sleep-guard
watchdog_label=com.qohfq.robinhood-local-watchdog
sleep_plist="$agent_dir/$sleep_label.plist"
watchdog_plist="$agent_dir/$watchdog_label.plist"
domain="gui/$(/usr/bin/id -u)"

print_action() {
  printf '%s\n' "$*"
}

bootout_managed() {
  label=$1
  plist=$2
  if [ "$no_load" = true ]; then
    return
  fi
  if [ "$dry_run" = true ]; then
    print_action "DRY-RUN: /bin/launchctl bootout $domain $plist"
    return
  fi
  /bin/launchctl bootout "$domain" "$plist" 2>/dev/null || true
  /bin/launchctl disable "$domain/$label" 2>/dev/null || true
}

if [ "$uninstall" = true ]; then
  print_action "Managed sleep guard: $sleep_plist"
  print_action "Managed watchdog: $watchdog_plist"
  print_action "Managed script: $watchdog_install"
  bootout_managed "$watchdog_label" "$watchdog_plist"
  bootout_managed "$sleep_label" "$sleep_plist"
  if [ "$dry_run" = true ]; then
    print_action "DRY-RUN: remove the three managed files above; retain watchdog reports and logs"
    exit 0
  fi
  /bin/rm -f -- "$watchdog_plist" "$sleep_plist" "$watchdog_install"
  /bin/rmdir "$bin_dir" 2>/dev/null || true
  # Reports and logs are deliberately retained for diagnosis. Empty parent
  # directories are removed, but no recursive deletion is performed.
  /bin/rmdir "$state_dir" 2>/dev/null || true
  /bin/rmdir "$support_dir" 2>/dev/null || true
  print_action "Removed the managed LaunchAgents and watchdog script. Reports/logs were retained if present."
  exit 0
fi

sleep_xml=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$sleep_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log_dir/ac-sleep-guard.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log_dir/ac-sleep-guard.err.log")</string>
</dict>
</plist>
EOF
)

watchdog_xml=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$watchdog_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$watchdog_install")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROJECT_DIR</key>
    <string>$(xml_escape "$project_dir")</string>
    <key>DATA_DIR</key>
    <string>$(xml_escape "$project_dir/data")</string>
    <key>WATCHDOG_STATE_DIR</key>
    <string>$(xml_escape "$state_dir")</string>
    <key>MAIN_LABEL</key>
    <string>com.qohfq.robinhood-launchpad-monitor</string>
    <key>FOMO_LABEL</key>
    <string>com.qohfq.fomo-call-monitor</string>
    <key>MAIN_HEARTBEAT</key>
    <string>$(xml_escape "$project_dir/data/main-runtime-heartbeat.json")</string>
    <key>FOMO_HEARTBEAT</key>
    <string>$(xml_escape "$project_dir/data/fomo-runtime-heartbeat.json")</string>
    <key>WATCHDOG_STALE_SECONDS</key>
    <string>120</string>
    <key>WATCHDOG_STALE_SAMPLES</key>
    <string>2</string>
    <key>WATCHDOG_COOLDOWN_SECONDS</key>
    <string>600</string>
    <key>WATCHDOG_RESTART_GRACE_SECONDS</key>
    <string>60</string>
    <key>WATCHDOG_NETWORK_HOST</key>
    <string>api.telegram.org</string>
    <key>WATCHDOG_NETWORK_URL</key>
    <string>https://api.telegram.org</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log_dir/local-watchdog.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log_dir/local-watchdog.err.log")</string>
</dict>
</plist>
EOF
)

if [ "$dry_run" = true ]; then
  print_action "DRY-RUN: create private support directory $support_dir (0700)"
  print_action "DRY-RUN: copy $script_dir/watchdog.sh to $watchdog_install (0700)"
  print_action "DRY-RUN: write $sleep_plist (0600)"
  printf '%s\n' "$sleep_xml"
  print_action "DRY-RUN: write $watchdog_plist (0600)"
  printf '%s\n' "$watchdog_xml"
  if [ "$no_load" = false ]; then
    print_action "DRY-RUN: bootstrap only $sleep_label and $watchdog_label"
  fi
  exit 0
fi

for path in "$agent_dir" "$support_dir" "$bin_dir" "$state_dir" "$log_dir"; do
  [ ! -L "$path" ] || die "managed directory must not be a symlink: $path"
  /bin/mkdir -p "$path"
done
/bin/chmod 700 "$support_dir" "$bin_dir" "$state_dir"
/usr/bin/install -m 0700 "$script_dir/watchdog.sh" "$watchdog_install"

write_plist() {
  destination=$1
  content=$2
  temporary="$destination.$$.tmp"
  printf '%s\n' "$content" > "$temporary"
  /bin/chmod 600 "$temporary"
  /usr/bin/plutil -lint "$temporary" >/dev/null
  /bin/mv -f "$temporary" "$destination"
}

write_plist "$sleep_plist" "$sleep_xml"
write_plist "$watchdog_plist" "$watchdog_xml"

if [ "$no_load" = false ]; then
  # Only the two units owned by this installer are touched. The production
  # monitor and Fomo LaunchAgents remain running throughout installation.
  /bin/launchctl bootout "$domain" "$watchdog_plist" 2>/dev/null || true
  /bin/launchctl bootout "$domain" "$sleep_plist" 2>/dev/null || true
  /bin/launchctl enable "$domain/$sleep_label"
  /bin/launchctl enable "$domain/$watchdog_label"
  /bin/launchctl bootstrap "$domain" "$sleep_plist"
  /bin/launchctl bootstrap "$domain" "$watchdog_plist"
fi

print_action "Installed AC-only sleep protection and the local watchdog. Existing production LaunchAgents were not edited or restarted."

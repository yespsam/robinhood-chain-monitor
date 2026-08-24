#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/robinhood-chain-monitor"
readonly RELEASES_DIR="$APP_DIR/releases"
readonly SERVICE_USER="robinhood-monitor"
readonly SERVICE_GROUP="robinhood-monitor"

fail() {
  printf 'release failed: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run as root"
[[ "$#" -ge 1 && "$#" -le 2 ]] || fail "usage: robinhood-release SOURCE_DIR [RELEASE_ID]"
[[ -x /usr/bin/node && -x /usr/bin/npm ]] || fail "/usr/bin/node and /usr/bin/npm are required"
node_major="$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  fail "/usr/bin/node must be Node.js 22 or newer"
fi
PATH=/usr/bin:/bin /usr/bin/npm --version >/dev/null 2>&1 \
  || fail "/usr/bin/npm is not usable with /usr/bin/node"

source_dir="$(cd -- "$1" 2>/dev/null && pwd -P)" || fail "source directory does not exist"
[[ "$source_dir" != "/" ]] || fail "refusing to use / as the source"
[[ -f "$source_dir/package-lock.json" && -f "$source_dir/src/index.js" && -f "$source_dir/src/fomo-worker.js" ]] \
  || fail "source is not a complete monitor checkout"

if [[ "$#" -eq 2 ]]; then
  release_id="$2"
else
  git_suffix="manual"
  if command -v git >/dev/null 2>&1 && git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_suffix="$(git -C "$source_dir" rev-parse --short=12 HEAD)"
  fi
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$git_suffix"
fi
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fail "invalid release ID"

release_dir="$RELEASES_DIR/$release_id"
[[ ! -e "$release_dir" ]] || fail "release already exists: $release_id"
install -d -o root -g root -m 0755 "$RELEASES_DIR" "$release_dir"

cleanup_failed_release() {
  if [[ -n "${release_dir:-}" && "$release_dir" == "$RELEASES_DIR/"* && -d "$release_dir" ]]; then
    rm -rf -- "$release_dir"
  fi
}
trap cleanup_failed_release ERR

rsync -a \
  --include='/.env.example' \
  --exclude='/.git/' \
  --exclude='/.github/' \
  --exclude='/.env' \
  --exclude='/.env.*' \
  --exclude='/data/' \
  --exclude='/coverage/' \
  --exclude='/node_modules/' \
  --exclude='/.playwright-cli/' \
  --exclude='*.key' \
  --exclude='*.pem' \
  --exclude='*.p12' \
  --exclude='*.pfx' \
  --exclude='*.jks' \
  --exclude='*.keystore' \
  --exclude='*.mobileprovision' \
  --exclude='/id_rsa' \
  --exclude='/id_rsa.pub' \
  --exclude='/id_ed25519' \
  --exclude='/id_ed25519.pub' \
  --exclude='/id_ecdsa' \
  --exclude='/id_ecdsa.pub' \
  --exclude='/id_dsa' \
  --exclude='/id_dsa.pub' \
  -- "$source_dir/" "$release_dir/"

(
  cd -- "$release_dir"
  PATH=/usr/bin:/bin /usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  /usr/bin/node --check src/index.js
  /usr/bin/node --check src/fomo-worker.js
  /usr/bin/node --check deploy/health-check.mjs
)

chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod 0644 {} +
find "$release_dir/deploy/bin" -type f -name '*.sh' -exec chmod 0755 {} +
trap - ERR

printf '%s\n' "$release_id"

#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 2 ]]; then
  printf 'usage: %s ENV_FILE KEY\n' "${0##*/}" >&2
  exit 64
fi

readonly ENV_FILE="$1"
readonly ENV_KEY="$2"

[[ -r "$ENV_FILE" ]] || {
  printf 'environment file is not readable: %s\n' "$ENV_FILE" >&2
  exit 66
}
[[ "$ENV_KEY" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
  printf 'invalid environment key: %s\n' "$ENV_KEY" >&2
  exit 64
}

# systemd applies the last assignment in an EnvironmentFile. Read only that
# assignment without sourcing a secret-bearing file or executing its contents.
awk -v target="$ENV_KEY" '
  function trim(value) {
    sub(/^[[:space:]]+/, "", value)
    sub(/[[:space:]]+$/, "", value)
    return value
  }
  {
    line = $0
    sub(/\r$/, "", line)
    line = trim(line)
    if (line == "" || line ~ /^[#;]/) next
    separator = index(line, "=")
    if (separator == 0) next
    name = trim(substr(line, 1, separator - 1))
    if (name != target) next
    value = trim(substr(line, separator + 1))
    if (length(value) >= 2) {
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
    }
    found = 1
    result = tolower(value)
  }
  END {
    if (found) print result
  }
' "$ENV_FILE"

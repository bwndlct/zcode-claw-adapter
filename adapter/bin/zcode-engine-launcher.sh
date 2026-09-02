#!/bin/bash

set -euo pipefail

INSTALL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTER="$INSTALL_ROOT/bin/zcode-app-server.mjs"

if [[ -z "${ZCODE_APPSERVER_KEY:-}" ]]; then
  ZCODE_DESKTOP_CONFIG="${ZCODE_DESKTOP_CONFIG:-$HOME/.zcode/v2/config.json}"
  if ! command -v jq >/dev/null 2>&1; then
    echo "[zcode-engine-launcher] jq is required for the authorized ZCode credential passthrough" >&2
    exit 4
  fi

  ZCODE_APPSERVER_KEY="$({
    jq -er '
      (.provider // {})
      | to_entries
      | map(select(
          (.value | type) == "object"
          and .value.enabled != false
          and (.value.systemDisabledReason // "") == ""
          and ((.value.options.apiKey // "") | length) > 0
          and ((.value.options.baseURL // "") | ascii_downcase | contains("z.ai"))
        ))
      | .[0].value.options.apiKey
    ' "$ZCODE_DESKTOP_CONFIG"
  } 2>/dev/null)" || {
    echo "[zcode-engine-launcher] no enabled Z.AI provider credential is available" >&2
    exit 4
  }
  export ZCODE_APPSERVER_KEY
fi

exec node "$ADAPTER" "$@"

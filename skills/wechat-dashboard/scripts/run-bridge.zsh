#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h:h:h}"
BRIDGE="$SCRIPT_DIR/dashboard-bridge.mjs"

function node_is_compatible() {
  local candidate="$1"
  [[ -x "$candidate" ]] || return 1
  "$candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)' >/dev/null 2>&1
}

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  SYSTEM_NODE="$(command -v node)"
  if node_is_compatible "$SYSTEM_NODE"; then
    NODE_BIN="$SYSTEM_NODE"
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  case "$(uname -m)" in
    arm64) RUNTIME_ARCH="arm64" ;;
    x86_64) RUNTIME_ARCH="x64" ;;
    *) RUNTIME_ARCH="unsupported" ;;
  esac
  LOCAL_NODE="$PROJECT_DIR/.runtime/node-v22.23.1-darwin-${RUNTIME_ARCH}/bin/node"
  if node_is_compatible "$LOCAL_NODE"; then
    NODE_BIN="$LOCAL_NODE"
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  print -u2 '{"status":"blocked","error_code":"NODE_RUNTIME_MISSING","summary":"找不到 Node.js 20.9 或更高版本。请在移交包中运行 INSTALL.command。"}'
  exit 1
fi

export PATH="${NODE_BIN:h}:$PATH"
exec "$NODE_BIN" "$BRIDGE" "$@"

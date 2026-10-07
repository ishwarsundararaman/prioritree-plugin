#!/bin/sh
set -eu
host_kind=${1:-claude}
node_path=
normalize_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi
}
use_node() {
  [ -n "$1" ] || return 1
  candidate=$(normalize_path "$1")
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  node_path=$candidate
}
if [ "$host_kind" = codex ]; then use_node "${CODEX_MCP_NODE_PATH:-}" || true; fi
if [ -z "$node_path" ]; then node_path=$(command -v node 2>/dev/null || true); fi
if [ -z "$node_path" ]; then use_node "${CODEX_MCP_NODE_PATH:-}" || true; fi
if [ -z "$node_path" ]; then
  user_home=$(normalize_path "${USERPROFILE:-${HOME:-}}")
  for candidate in "$user_home/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" "$user_home/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"; do
    use_node "$candidate" && break || true
  done
fi
if [ -z "$node_path" ]; then
  printf '%s\n' 'PrioriTree needs Node.js 20.19 or newer. Install Node.js LTS and restart your host, or use Codex with its bundled Node runtime.' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "${0%/*}" && pwd)
exec "$node_path" "$script_dir/../server/work-map.mjs"

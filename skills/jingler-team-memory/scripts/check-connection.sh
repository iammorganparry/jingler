#!/usr/bin/env bash
# Verify a Jingler team-memory MCP connection by listing the server's tools.
# Usage: check-connection.sh <base-url> <token> <organization-id>
#   e.g. check-connection.sh http://localhost:9100 pat_xxx org_abc123
set -euo pipefail

URL="${1:?usage: check-connection.sh <base-url> <token> <organization-id>}"
TOKEN="${2:?token required (arg 2)}"
ORG="${3:?organization id required (arg 3)}"
ENDPOINT="${URL%/}/api/mcp"

response=$(curl -sS -m 15 -w $'\n%{http_code}' -X POST "$ENDPOINT" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-jingler-organization-id: ${ORG}" \
  -H "content-type: application/json" \
  -H "mcp-protocol-version: 2026-07-28" \
  -d '{"jsonrpc":"2.0","id":"check-connection","method":"tools/list","params":{}}') || {
    echo "✗ Could not reach ${ENDPOINT} (network error / server down)." >&2
    exit 1
  }

code=$(printf '%s\n' "$response" | tail -n1)
body=$(printf '%s\n' "$response" | sed '$d')

case "$code" in
  200)
    tools=$(printf '%s' "$body" | grep -oE '"name":"memory_[a-z_]+"' | sed 's/.*:"//;s/"//' | sort -u)
    if [ -n "$tools" ]; then
      echo "✓ Connected to ${ENDPOINT}. Available tools:"
      printf '  - %s\n' $tools
    else
      echo "✓ Connected (HTTP 200) but no memory_* tools were listed. Raw response:"
      printf '%s\n' "$body"
    fi
    ;;
  401) echo "✗ 401 Unauthorized — token missing/invalid, or the x-jingler-organization-id header is absent." >&2; exit 1 ;;
  403) echo "✗ 403 Forbidden — this organization is not on a plan that enables team memory." >&2; exit 1 ;;
  *)   echo "✗ Unexpected HTTP ${code}:" >&2; printf '%s\n' "$body" >&2; exit 1 ;;
esac

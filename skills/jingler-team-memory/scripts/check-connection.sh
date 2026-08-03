#!/usr/bin/env bash
# Verify a Jingler team-memory MCP connection by listing the server's tools.
# Usage: JINGLER_MEMORY_TOKEN=<token> check-connection.sh <base-url> <organization-id>
# Keep the credential out of argv so it never appears in process listings.
set -euo pipefail

URL="${1:?usage: JINGLER_MEMORY_TOKEN=<token> check-connection.sh <base-url> <organization-id>}"
ORG="${2:?organization id required (arg 2)}"
TOKEN="${JINGLER_MEMORY_TOKEN:?JINGLER_MEMORY_TOKEN is required}"
ENDPOINT="${URL%/}/api/mcp"

response=$(curl -sS -m 15 -w $'\n%{http_code}' -X POST "$ENDPOINT" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-jingler-organization-id: ${ORG}" \
  -H "content-type: application/json" \
  -H "mcp-protocol-version: 2026-07-28" \
  -H "mcp-method: tools/list" \
  -d '{"jsonrpc":"2.0","id":"check-connection","method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"jingler-memory-connection-check","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}') || {
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

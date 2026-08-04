#!/bin/sh
# recall.sh — deterministic team-memory recall for a pre-turn harness hook.
#
# Wire this to a context-injecting hook (Claude Code `UserPromptSubmit`). The
# harness pipes the hook payload as JSON on stdin; we pull the user's prompt out
# of it, search Jingler team memory for related pages, read the accepted pages,
# and print the bounded page records to STDOUT wrapped in one
# <recalled-memories>…</recalled-memories> block.
# Claude Code injects a UserPromptSubmit hook's stdout into the model context, so
# that block becomes deterministic recall the model sees before it answers.
#
# Auth comes from the environment (never args, never logged):
#   JINGLER_MEMORY_URL    e.g. http://localhost:9100
#   JINGLER_MEMORY_TOKEN  a jmem_… personal access token
#   JINGLER_MEMORY_ORG    organization id
#
# FAIL OPEN, ALWAYS: any missing config, network error, non-200, or parse
# failure exits 0 with no output. A recall hook must never block or break a turn.
# The token is never printed.

# Read the whole stdin payload (the hook JSON). Never fail if stdin is empty.
PAYLOAD=$(cat 2>/dev/null || true)

# --- extract the user prompt from the hook payload -------------------------
# Claude Code UserPromptSubmit sends {"prompt":"…", …}. Prefer jq; fall back to
# a best-effort sed extraction of the "prompt" string. If we can't find one, use
# the raw payload as the query (still useful) — but if that's empty, bail open.
PROMPT=""
if command -v jq >/dev/null 2>&1; then
  PROMPT=$(printf '%s' "$PAYLOAD" | jq -r '.prompt // .user_prompt // .input // empty' 2>/dev/null || true)
fi
if [ -z "$PROMPT" ]; then
  # Fallback: grab the first "prompt":"…" value, unescaping \" and \n crudely.
  PROMPT=$(printf '%s' "$PAYLOAD" \
    | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\(\([^"\\]\|\\.\)*\)".*/\1/p' \
    | sed 's/\\"/"/g; s/\\n/ /g; s/\\t/ /g; s/\\\\/\\/g' \
    | head -c 4000)
fi
# Last resort: treat the raw payload as the query text.
[ -z "$PROMPT" ] && PROMPT=$(printf '%s' "$PAYLOAD" | tr '\n' ' ' | head -c 4000)

# Nothing to search on → nothing to inject. Exit open.
[ -z "$PROMPT" ] && exit 0

# --- config check (fail open if unconfigured) ------------------------------
[ -z "${JINGLER_MEMORY_URL:-}" ] && exit 0
[ -z "${JINGLER_MEMORY_TOKEN:-}" ] && exit 0
[ -z "${JINGLER_MEMORY_ORG:-}" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

ENDPOINT="${JINGLER_MEMORY_URL%/}/api/mcp"
LIMIT=5
READ_LIMIT=3

# --- build and send a JSON-RPC search request ------------------------------
# jq builds a correctly-escaped body when present; otherwise escape the query by
# hand (backslash, quote, control chars) so we still emit valid JSON.
search_memory() {
  query=$1
  if command -v jq >/dev/null 2>&1; then
    body=$(jq -cn --arg q "$query" --argjson n "$LIMIT" \
    '{jsonrpc:"2.0",id:"recall",method:"tools/call",params:{name:"memory_search",arguments:{query:$q,limit:$n},_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"jingler-memory-recall-hook",version:"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' \
      2>/dev/null) || return 0
  else
    esc=$(printf '%s' "$query" \
      | sed 's/\\/\\\\/g; s/"/\\"/g' \
      | tr '\n\r\t' '   ')
    body=$(printf '{"jsonrpc":"2.0","id":"recall","method":"tools/call","params":{"name":"memory_search","arguments":{"query":"%s","limit":%s},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"jingler-memory-recall-hook","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' "$esc" "$LIMIT")
  fi

  curl -sS -m 4 --connect-timeout 2 -X POST "$ENDPOINT" \
    -H "Authorization: Bearer ${JINGLER_MEMORY_TOKEN}" \
    -H "x-jingler-organization-id: ${JINGLER_MEMORY_ORG}" \
    -H "content-type: application/json" \
    -H "mcp-protocol-version: 2026-07-28" \
    -H "mcp-method: tools/call" \
    -H "mcp-name: memory_search" \
    -d "$body" 2>/dev/null || true
}

RESP=$(search_memory "$PROMPT")

[ -z "$RESP" ] && exit 0

# --- resolve search hits to accepted pages ---------------------------------
# Search snippets are discovery hints, not accepted evidence. Extract only
# stable page ids, then memory_read up to READ_LIMIT pages. This guarantees the
# injected context came from the accepted page endpoint and includes the ids an
# agent needs to ground or refresh it.
extract_page_ids() {
  printf '%s' "$1" | jq -r '
    ( .result.structuredContent.data
      // .result.structuredContent.results
      // .result.structuredContent
      // [] ) as $d
    | (if ($d|type)=="array" then $d else ($d.data // $d.results // []) end)
    | map(select(type=="object"))
    | .[]
    | (.pageId // .id // .page_id // empty)
  ' 2>/dev/null || true
}

read_memory() {
  page_id=$1
  body=$(jq -cn --arg id "$page_id" \
    '{jsonrpc:"2.0",id:"recall-read",method:"tools/call",params:{name:"memory_read",arguments:{pageId:$id},_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"jingler-memory-recall-hook",version:"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' \
    2>/dev/null) || return 0

  curl -sS -m 3 --connect-timeout 1 -X POST "$ENDPOINT" \
    -H "Authorization: Bearer ${JINGLER_MEMORY_TOKEN}" \
    -H "x-jingler-organization-id: ${JINGLER_MEMORY_ORG}" \
    -H "content-type: application/json" \
    -H "mcp-protocol-version: 2026-07-28" \
    -H "mcp-method: tools/call" \
    -H "mcp-name: memory_read" \
    -d "$body" 2>/dev/null || true
}

format_read_page() {
  printf '%s' "$1" | jq -r '
    ( .result.structuredContent.data
      // .result.structuredContent
      // empty ) as $d
    | ($d.page // $d) as $p
    | ($p.id // $d.pageId // empty) as $pageId
    | ($d.revision.id // $d.revisionId // empty) as $revisionId
    | ($p.body // $p.markdown // $d.body // $d.markdown // "") as $body
    | select($pageId != "" and $revisionId != "")
    | {
        pageId: $pageId,
        revisionId: $revisionId,
        sourceIds: ($d.sourceIds // []),
        citationIds: ($d.citationIds // []),
        title: ($p.title // "Untitled"),
        body: $body[0:4000],
        bodyTruncated: (($body | length) > 4000)
      }
    | @json
    | gsub("<"; "\\u003c")
  ' 2>/dev/null || true
}

PAGE_IDS=""
if command -v jq >/dev/null 2>&1; then
  PAGE_IDS=$(extract_page_ids "$RESP" | awk '!seen[$0]++' | head -n "$READ_LIMIT")

  # The vault's lexical search is literal-substring based. A whole natural-
  # language question can therefore miss a page even when a distinctive term
  # matches. Retry once with the longest useful prompt term; one bounded fallback
  # keeps hook latency predictable while making normal question prompts useful.
  if [ -z "$PAGE_IDS" ]; then
    FALLBACK=$(printf '%s' "$PROMPT" | jq -Rr '
      [scan("[[:alnum:]_-]{4,}")
        | ascii_downcase
        | select(IN("what","when","where","which","while","would","could","should","about","from","that","this","with","have","does","were","been","into","your","their") | not)]
      | sort_by(length) | reverse | .[0] // empty
    ' 2>/dev/null || true)
    if [ -n "$FALLBACK" ] && [ "$FALLBACK" != "$PROMPT" ]; then
      RESP=$(search_memory "$FALLBACK")
      [ -n "$RESP" ] && PAGE_IDS=$(extract_page_ids "$RESP" | awk '!seen[$0]++' | head -n "$READ_LIMIT")
    fi
  fi
fi

# No jq, or jq produced nothing: emit nothing rather than dumping raw JSON
# (which could be large and is not useful context). Fail open.
[ -z "$PAGE_IDS" ] && exit 0

# Accepted-page reads are independent. Run the bounded set concurrently so a
# slow page costs one read timeout, not READ_LIMIT sequential timeouts. Numbered
# files preserve search order without sharing shell variables across subshells.
READ_DIR=$(mktemp -d "${TMPDIR:-/tmp}/jingler-memory-recall.XXXXXX" 2>/dev/null || true)
[ -z "$READ_DIR" ] && exit 0
trap 'rm -rf "$READ_DIR"' EXIT HUP INT TERM

read_index=0
read_pids=""
while IFS= read -r page_id; do
  [ -z "$page_id" ] && continue
  read_index=$((read_index + 1))
  (
    page_response=$(read_memory "$page_id")
    [ -n "$page_response" ] && format_read_page "$page_response"
  ) > "$READ_DIR/$read_index" &
  read_pids="$read_pids $!"
done <<EOF
$PAGE_IDS
EOF

for read_pid in $read_pids; do
  wait "$read_pid" 2>/dev/null || true
done

OUT=""
read_index=1
while [ "$read_index" -le "$READ_LIMIT" ]; do
  [ -s "$READ_DIR/$read_index" ] && OUT="${OUT}$(cat "$READ_DIR/$read_index")
"
  read_index=$((read_index + 1))
done
OUT=$(printf '%s' "$OUT" | sed '/^$/d')

# Do not fall back to snippets if every accepted-page read failed. That keeps
# the hook's trust boundary identical to the skill: read before relying.
[ -z "$OUT" ] && exit 0

printf '<recalled-memories>\n'
printf 'Accepted team-memory pages (verify cited sources when it matters):\n'
printf '%s\n' "$OUT"
printf '</recalled-memories>\n'
exit 0

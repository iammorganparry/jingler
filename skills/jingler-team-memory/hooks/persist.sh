#!/bin/sh
# persist.sh — deterministic, GATED team-memory submission for a post-turn hook.
#
# Wire this to a post-turn hook (Claude Code `Stop`, Codex `notify`). It fires
# every turn, but it only submits when the turn actually produced something
# worth keeping — it does NOT spam the vault on every turn.
#
# Gating heuristic (simple and explicit, first match wins):
#   1. $JINGLER_MEMORY_NOTE — if set and non-empty, submit exactly that text.
#   2. First CLI argument   — persist.sh "the thing to remember".
#   3. A "MEMORY:" line in the turn transcript — the model opts in by writing a
#      line that starts with `MEMORY:` (case-insensitive). Each such line becomes
#      one memory. No marker → nothing is submitted. This keeps submission
#      deterministic in timing but selective in content: the agent decides what
#      is durable by marking it, exactly as it would decide to call memory_propose.
# If none match, exit 0 without touching the network.
#
# Auth from the environment (never args, never logged):
#   JINGLER_MEMORY_URL / JINGLER_MEMORY_TOKEN / JINGLER_MEMORY_ORG
#
# FAIL OPEN: missing config, no candidate, network error, or non-200 → exit 0.
# The token is never printed.

PAYLOAD=$(cat 2>/dev/null || true)

# Codex passes its `agent-turn-complete` notification as the first argv value,
# while Claude Code sends hook JSON on stdin. Treat a JSON-shaped first argument
# as hook payload, never as a note to publish.
ARG_NOTE="${1:-}"
case "$ARG_NOTE" in
  \{*)
    [ -z "$PAYLOAD" ] && PAYLOAD="$ARG_NOTE"
    ARG_NOTE=""
    ;;
esac

# --- gather candidate memories (newline-separated) -------------------------
CANDIDATES=""
SINGLE_CANDIDATE=0

if [ -n "${JINGLER_MEMORY_NOTE:-}" ]; then
  CANDIDATES="$JINGLER_MEMORY_NOTE"
  SINGLE_CANDIDATE=1
elif [ -n "$ARG_NOTE" ]; then
  CANDIDATES="$ARG_NOTE"
  SINGLE_CANDIDATE=1
else
  # Codex exposes the completed response directly in its notification payload.
  # Claude Code instead provides a transcript path. Normalize either to RAW,
  # then scan only explicit MEMORY: marker lines.
  RAW=""
  if command -v jq >/dev/null 2>&1; then
    RAW=$(printf '%s' "$PAYLOAD" | jq -r '
      ."last-assistant-message"
      // .last_assistant_message
      // .assistant_message
      // empty
    ' 2>/dev/null || true)
  fi
  if [ -z "$RAW" ]; then
    RAW=$(printf '%s' "$PAYLOAD" \
      | sed -n 's/.*"last-assistant-message"[[:space:]]*:[[:space:]]*"\(.*\)"[[:space:]]*}.*/\1/p' \
      | sed 's/\\"/"/g; s/\\t/ /g; s/\\\\/\\/g')
  fi

  TRANSCRIPT=""
  if [ -z "$RAW" ] && command -v jq >/dev/null 2>&1; then
    TRANSCRIPT=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // .transcriptPath // .transcript // empty' 2>/dev/null || true)
  fi
  if [ -z "$RAW" ] && [ -z "$TRANSCRIPT" ]; then
    TRANSCRIPT=$(printf '%s' "$PAYLOAD" \
      | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n1)
  fi
  # Expand a leading ~ to $HOME.
  case "$TRANSCRIPT" in "~"/*) TRANSCRIPT="$HOME/${TRANSCRIPT#~/}" ;; esac

  if [ -z "$RAW" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    # Pull assistant text out of the JSONL transcript, then keep only MEMORY: lines.
    if command -v jq >/dev/null 2>&1; then
      RAW=$(jq -r '
        ( .message.content? // .content? // empty )
        | if type=="array" then (map(.text? // empty) | join("\n"))
          elif type=="string" then .
          else empty end
      ' "$TRANSCRIPT" 2>/dev/null || true)
    fi
    [ -z "$RAW" ] && RAW=$(cat "$TRANSCRIPT" 2>/dev/null || true)
  fi

  if [ -n "$RAW" ]; then
    # Keep only explicit marker lines. A Codex notification that contains no
    # marker therefore produces no request instead of persisting its JSON.
    CANDIDATES=$(printf '%s\n' "$RAW" \
      | sed 's/\\n/\
/g' \
      | grep -iE '^[[:space:]]*MEMORY:' 2>/dev/null \
      | sed 's/^[[:space:]]*[Mm][Ee][Mm][Oo][Rr][Yy]:[[:space:]]*//' \
      | sed 's/\\n.*//; s/\\"/"/g' \
      | sed '/^[[:space:]]*$/d' \
      | head -n 5)
  fi
fi

# Nothing worth storing this turn → exit open, no network call.
[ -z "$CANDIDATES" ] && exit 0

# --- config check (fail open if unconfigured) ------------------------------
[ -z "${JINGLER_MEMORY_URL:-}" ] && exit 0
[ -z "${JINGLER_MEMORY_TOKEN:-}" ] && exit 0
[ -z "${JINGLER_MEMORY_ORG:-}" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

ENDPOINT="${JINGLER_MEMORY_URL%/}/api/mcp"

# --- submit each candidate as a new page proposal --------------------------
# baseRevisionId is "new" for a fresh page. pageId is a slug derived from the
# text so repeated identical notes stay idempotent (server dedupes by
# identity+content too). We never print the token or the full response.
publish() {
  note=$1
  [ -z "$note" ] && return 0

  # Derive a short, stable slug pageId from the note text.
  slug=$(printf '%s' "$note" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//' \
    | cut -c1-48)
  [ -z "$slug" ] && slug="memory"
  pageid="mem-${slug}"

  if command -v jq >/dev/null 2>&1; then
    body=$(jq -cn --arg id "$pageid" --arg md "$note" \
      '{jsonrpc:"2.0",id:"persist",method:"tools/call",params:{name:"memory_propose",arguments:{pageId:$id,baseRevisionId:"new",markdown:$md},_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"jingler-memory-persist-hook",version:"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' \
      2>/dev/null) || return 0
  else
    esc=$(printf '%s' "$note" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   ')
    body=$(printf '{"jsonrpc":"2.0","id":"persist","method":"tools/call","params":{"name":"memory_propose","arguments":{"pageId":"%s","baseRevisionId":"new","markdown":"%s"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"jingler-memory-persist-hook","version":"1.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' "$pageid" "$esc")
  fi

  curl -sS -m 8 --connect-timeout 4 -X POST "$ENDPOINT" \
    -H "Authorization: Bearer ${JINGLER_MEMORY_TOKEN}" \
    -H "x-jingler-organization-id: ${JINGLER_MEMORY_ORG}" \
    -H "content-type: application/json" \
    -H "mcp-protocol-version: 2026-07-28" \
    -H "mcp-method: tools/call" \
    -H "mcp-name: memory_propose" \
    -d "$body" >/dev/null 2>&1 || return 0
}

# An explicit env/argv note is one memory even when it spans lines. Transcript
# markers remain one memory per line (bounded to five above).
if [ "$SINGLE_CANDIDATE" -eq 1 ]; then
  publish "$CANDIDATES"
else
  printf '%s\n' "$CANDIDATES" | while IFS= read -r line; do
    [ -n "$line" ] && publish "$line"
  done
fi

exit 0

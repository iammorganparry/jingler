# Codex — deterministic persist, best-effort recall

Codex's hook surface is asymmetric, so be honest about what is deterministic here:

- **Post-turn (persist): deterministic.** Codex supports a `notify` hook that runs
  an external program when the agent finishes/awaits. Wire `persist.sh` there and
  end-of-turn submission is deterministic, exactly as on Claude Code. Publication
  still waits for approval when the organization has review enabled.
- **Pre-turn (recall): weak.** Codex has **no** `UserPromptSubmit`-equivalent that
  injects a hook's stdout into the model context before the turn. There is no
  deterministic pre-turn injection point. So on Codex, **recall stays the skill's
  job** — the `jingler-team-memory` SKILL.md instructs the agent to `memory_search`
  first over MCP. The MCP server repeats the recall/read/propose/poll rules in its
  native `initialize` instructions, so Codex sees them even if it does not activate
  the skill; acting on either instruction is still model-mediated. Set expectations
  accordingly.

## 1. Environment variables

Same three vars as everywhere; export them where Codex is launched so the `notify`
subprocess inherits them:

```sh
export JINGLER_MEMORY_URL="http://localhost:9100"
export JINGLER_MEMORY_TOKEN="jmem_xxxxxxxxxxxxxxxxxxxx"
export JINGLER_MEMORY_ORG="org_xxxxxxxxxxxxxxxx"
```

Keep the token out of `config.toml` by using Codex's environment-backed HTTP auth:

```toml
[mcp_servers.jingler-memory]
url = "https://memory.example.com/api/mcp"
bearer_token_env_var = "JINGLER_MEMORY_TOKEN"

[mcp_servers.jingler-memory.env_http_headers]
x-jingler-organization-id = "JINGLER_MEMORY_ORG"
```

## 2. Wire persist to the `notify` hook

In `~/.codex/config.toml`, point `notify` at `persist.sh` (absolute path):

```toml
notify = ["sh", "/ABSOLUTE/PATH/TO/skills/jingler-team-memory/hooks/persist.sh"]
```

Codex invokes `notify` with a JSON argument describing the turn. `persist.sh`
recognizes that JSON as hook payload (never as a note) and scans the
`last-assistant-message` field for explicit `MEMORY:` markers. You can also set
`JINGLER_MEMORY_NOTE` when an external wrapper has already selected a note:

```toml
notify = ["sh", "/ABSOLUTE/PATH/TO/.../persist.sh"]
```

The gating precedence is identical to Claude Code: `JINGLER_MEMORY_NOTE` →
first arg → `MEMORY:` lines in the transcript. No candidate → nothing submitted.

## 3. Recall on Codex = the skill

Because there is no deterministic pre-turn injection, keep the
`jingler-team-memory` skill active: it tells the agent to `memory_search` team
memory and `memory_read` accepted hits before answering or acting. The server's
MCP initialization instructions provide the same fallback at connection time. If
Codex later adds a context-injecting pre-turn hook, wire `recall.sh` to it the same
way Claude Code's `UserPromptSubmit` does — the script is harness-agnostic and
reads its prompt defensively from whatever JSON it is handed on stdin.

## 4. Verify fail-open

```sh
echo '{}' | JINGLER_MEMORY_URL=http://127.0.0.1:0 JINGLER_MEMORY_TOKEN= JINGLER_MEMORY_ORG= sh persist.sh; echo "exit=$?"
```
prints nothing and `exit=0`.
```

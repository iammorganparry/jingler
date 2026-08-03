# Deterministic recall/persist — lifecycle hooks

The skill (`SKILL.md`) tells an agent to recall first and remember after. That is
**best-effort**: it only happens if the model chooses to act on it. Lifecycle
**hooks** are shell commands the *harness itself* runs at fixed points in a turn,
so memory use becomes **deterministic** — it happens whether or not the model
remembers to.

## The two models, and how they combine

| | Best-effort (skill) | Deterministic (hook) |
|---|---|---|
| Who acts | the model, mid-turn | the harness, at a lifecycle point |
| Recall | model calls `memory_search` if it decides to | a pre-turn hook injects `<recalled-memories>` every turn |
| Persist | model calls `memory_propose` if it decides to | a post-turn hook submits marked memories every turn |
| Reliability | depends on the prompt landing | fires regardless |

Use hooks **where the harness supports them**, and keep the **skill as the
fallback** — for harnesses without the right hook point (recall on Codex), and as
the in-turn judgment layer that decides *what* is worth marking for persist.

## The hooks

- **`hooks/recall.sh`** — pre-turn. Reads the hook payload on stdin, extracts the
  user prompt, `memory_search`es it (limit 5), and prints the top hits wrapped in a
  single `<recalled-memories>…</recalled-memories>` block to stdout. On Claude
  Code's `UserPromptSubmit`, that stdout is injected into the model context — so
  the model sees relevant team memory before it answers, deterministically.

- **`hooks/persist.sh`** — post-turn. Fires every turn but is **gated**: it
  submits only when the turn produced a clear candidate, in precedence order —
  `JINGLER_MEMORY_NOTE` env var, then a CLI arg, then any `MEMORY:` marker line in
  the Claude transcript or Codex `last-assistant-message` (max 5/turn). Hook JSON
  passed as an argument is recognized as payload and is never itself submitted.
  No candidate → no network call. This keeps the
  *timing* deterministic without spamming the vault. Submission starts the
  compiler; organizations with review enabled publish only after a maintainer
  accepts the resulting proposal.

Both scripts are POSIX `sh`, need only `curl` (use `jq` if present, degrade
without it), read auth from `JINGLER_MEMORY_URL` / `JINGLER_MEMORY_TOKEN` /
`JINGLER_MEMORY_ORG`, **fail open** on any error (exit 0, no output), and never
print the token.

## Wiring, per harness

- **Claude Code** — both hooks are deterministic. See
  [../hooks/config/claude-code.md](../hooks/config/claude-code.md) for the exact
  `.claude/settings.json` block (`UserPromptSubmit` → `recall.sh`, `Stop` →
  `persist.sh`).
- **Codex** — persist is deterministic via the `notify` hook; recall has no
  deterministic pre-turn injection point, so it stays the skill's job. See
  [../hooks/config/codex.md](../hooks/config/codex.md).
- **Other MCP harnesses** — if the harness has a context-injecting pre-turn hook
  and/or a post-turn hook, wire the same two scripts to them; they read their
  payload defensively from stdin and are harness-agnostic. Otherwise the skill
  remains the recall/persist path.

# Claude Code — deterministic recall/persist hooks

Claude Code runs shell commands at fixed lifecycle points. Two of them make team
memory deterministic instead of best-effort:

- **`UserPromptSubmit`** runs before the model sees your prompt, and its **stdout
  is injected into the model's context**. `recall.sh` uses this to search team
  memory, read up to three accepted pages, and inject a bounded
  `<recalled-memories>` block with stable evidence ids every turn — no reliance
  on the model choosing to search or on unverified snippets.
- **`Stop`** runs after the assistant finishes a turn. `persist.sh` uses it to
  submit anything the turn marked as worth keeping for automatic compilation and
  publication (see gating below).

## 1. Set the three environment variables

The scripts read auth from the environment (never from args, never logged). Export
these in the shell that launches Claude Code (e.g. your shell profile), so the
hook subprocesses inherit them:

```sh
export JINGLER_MEMORY_URL="http://localhost:9100"      # your memory server base URL
export JINGLER_MEMORY_TOKEN="jmem_xxxxxxxxxxxxxxxxxxxx" # a jmem_… personal access token
export JINGLER_MEMORY_ORG="org_xxxxxxxxxxxxxxxx"        # your organization id
```

If any of the three is unset, both scripts fail open (do nothing) — recall injects
no block, persist submits nothing. Nothing breaks.

## 2. Add the hooks block to `.claude/settings.json`

Use an absolute path to the scripts (adjust the prefix to where this repo lives).
Copy-paste the `hooks` block into your project's `.claude/settings.json` (or your
user-level `~/.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh /ABSOLUTE/PATH/TO/skills/jingler-team-memory/hooks/recall.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh /ABSOLUTE/PATH/TO/skills/jingler-team-memory/hooks/persist.sh"
          }
        ]
      }
    ]
  }
}
```

Claude Code pipes the hook payload as JSON on stdin to each command, which is
exactly what the scripts read. `recall.sh` gets `{"prompt": "…"}`; `persist.sh`
gets a payload including `transcript_path`.

## 3. How persist is gated (it does NOT submit every turn)

`persist.sh` fires every `Stop`, but only submits when the turn produced a clear
candidate, in this precedence:

1. `JINGLER_MEMORY_NOTE` env var, if set — submits exactly that text.
2. A first CLI argument, if you add one to the `command` above.
3. A **`MEMORY:` line** in the turn transcript. The model opts in by writing a line
   that starts with `MEMORY:` — e.g. `MEMORY: We standardised on port 5433 for the
   dev Postgres to avoid clashing with a host 5432.` Each such line becomes one
   memory (max 5/turn). No marker → nothing is submitted.

Submission starts the compiler and publishes automatically when compilation
settles successfully; no maintainer approval is required.

This mirrors how the model would decide to call `memory_propose`, but makes the
*timing* deterministic: the harness always checks at end-of-turn.

## 4. Verify

- `sh -n recall.sh && sh -n persist.sh` — syntax check.
- Prove fail-open with no server:
  `echo '{"prompt":"hi"}' | JINGLER_MEMORY_URL=http://127.0.0.1:0 JINGLER_MEMORY_TOKEN= JINGLER_MEMORY_ORG= sh recall.sh; echo "exit=$?"`
  should print nothing and `exit=0`.
```

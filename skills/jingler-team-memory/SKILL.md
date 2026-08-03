---
name: jingler-team-memory
description: >-
  Connect to and use Jingler's hosted team-memory MCP server — a shared, cross-agent
  memory the whole team reads from and writes to. Works in any MCP-capable harness
  (Claude Code, Codex, Cursor, etc.). RECALL FIRST: before answering ANY question or
  starting ANY task, search team memory to see whether the team already knows the
  answer, BEFORE exploring code, docs, or the web — the question does not have to be
  about code. REMEMBER ANYTHING WORTH REMEMBERING: whenever something surfaces that
  future-you or a teammate would want to know again — a decision, a fact, a
  convention, a preference, a person/process detail, a gotcha, a hard-won answer —
  publish it, in any domain, not only code. Also use when the user says "check/search
  our memory", "remember this", "what do we know about…", or asks to set up / connect
  an agent to the shared memory MCP. Trigger proactively and by default, not only when
  memory is explicitly named.
---

# Jingler Team Memory

Jingler team memory is a hosted, shared knowledge base every team agent reads from and
writes to over MCP. It holds the team's *derived* knowledge of every kind — decisions,
facts, conventions, preferences, people and process, gotchas, hard-won answers — the
things worth knowing again that aren't sitting in any one file to be rediscovered.

Two habits make it valuable, and they apply to **any** question or task, not just
coding ones:

- **Recall first.** Before you answer a question or start work, check memory — the
  team may already know. Do this before you go digging in code, docs, or the web.
- **Remember anything worth remembering.** When something comes up that you or a
  teammate would want again later, publish it. If it's worth remembering, it belongs
  here — regardless of domain.

## One-time setup

The memory server is a remote MCP endpoint at `<JINGLER_MEMORY_URL>/api/mcp`,
authenticated with a bearer token and scoped to one organization. Add it once per
harness.

For how to obtain a token and base URL, and copy-paste config for Claude Code,
Codex, Cursor, and generic MCP clients, read **[references/setup.md](references/setup.md)**.

Verify the connection after configuring it:

```bash
JINGLER_MEMORY_TOKEN="<TOKEN>" \
  scripts/check-connection.sh "<JINGLER_MEMORY_URL>" "<ORGANIZATION_ID>"
```

A healthy server lists its tools (`memory_search`, `memory_propose`, …). A 401/403
means the token is missing/wrong, the organization header is absent, or the org is
not on a plan that enables memory.

## Deterministic recall/persist (hooks)

This skill is best-effort — recall and remember only happen if the agent acts on
them. Where a harness supports lifecycle **hooks**, make them deterministic
instead: a pre-turn hook injects `<recalled-memories>` every turn and a post-turn
hook submits marked memories for compilation and any configured review. Wiring for Claude Code (both) and Codex (persist;
recall stays the skill) is in **[references/hooks.md](references/hooks.md)**.

## Workflow — recall first, remember after

### Recall first (before answering or acting)

Do this for essentially every non-trivial question or task, whatever the topic:

1. `memory_search` with the question/task in plain language (a name, an error, a
   topic, a person, a decision). Returns ranked pages.
2. `memory_read` the top hits to load each full page body before relying on it.
3. If a page is central, expand around it with `memory_suggestions` (related pages)
   or `memory_graph_neighborhood` (its linked neighbours).
4. Use what you find and say so ("Team memory says we standardised on X because…").
   Memory is authoritative for team-derived knowledge but advisory for facts it
   cites — verify against the source (code, doc, ticket) when it matters.

Only skip the recall step for genuinely trivial or self-contained questions. When in
doubt, search — it's cheap and often decisive, and it's how the team's knowledge
compounds instead of being rediscovered.

### Remember after (when something is worth keeping)

Whenever you learn or decide something a teammate would want later, publish it with
`memory_propose` — don't wait to be asked:

- Write **one standalone fact per memory** — future readers have no session context.
  Include the WHY, not just the WHAT.
- Worth remembering (any domain): a decision + its reasoning; a convention or team
  preference; a non-obvious gotcha + root cause; how something connects to something
  else; a hard-won answer to a question that took real effort; a fact about the
  product, process, or people that isn't written down elsewhere.
- Skip: trivia, anything already in the docs, and ephemeral details (line numbers,
  temp paths, one-off values).
- Cite where the memory came from (a file, a PR, a ticket, a conversation) when there
  is a source.

Publishing is **auto-accept by default**: the memory becomes shared knowledge
immediately, and the vault's versioning + contradiction/health checks let the team
audit and revert. Some organizations enable a human review gate — there, a proposal
waits in the review queue until a maintainer accepts it. Either way, propose; don't
self-censor durable learnings.

## Tools — quick selection

| Goal | Tool |
|------|------|
| Find pages for a task/topic | `memory_search` |
| Load a page's full body | `memory_read` |
| Related pages for a page | `memory_suggestions` |
| A page's linked neighbours | `memory_graph_neighborhood` |
| The whole bounded graph | `memory_graph` |
| Vault health / activity overview | `memory_dashboard` |
| Publish a new/updated memory | `memory_propose` |

For the full catalog — every tool, its arguments, and when to use it (including the
review, edge-evidence, navigation, schema-publish, and export tools) — read
**[references/tools.md](references/tools.md)**.

## Notes

- Memory is scoped to one organization; the token and the `x-jingler-organization-id`
  header fix which. Never paste a token into code or logs — it's a credential.
- Retrieval and publication are best-effort: if the server is unreachable, proceed
  with the task and note that memory was unavailable rather than blocking.

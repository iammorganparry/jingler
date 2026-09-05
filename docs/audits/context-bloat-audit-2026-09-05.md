# Harness context bloat audit — 2026-09-05

## Scope

Pi harness sessions in `~/jingler/pi-sessions`, plus the shared prompt compiler and managed-resource tools in `packages/cli-adapters`. Desktop-only UI and loading paths were excluded.

Token counts below are provider-reported input occupancy from the first assistant message. Prompt section estimates use the harness compiler's existing `ceil(chars / 4)` accounting.

## Comparable sessions

| Session | Role shape | First input tokens |
| --- | --- | ---: |
| `2026-09-04T11-59-58-179Z_01a06c4a-36e3-768c-9a89-162284a4b42c.jsonl` | Full conversation | 13,494 |
| `2026-09-05T07-39-54-024Z_01a07082-7928-7967-9a81-99680d468675.jsonl` | Full conversation | 13,439 |

The baseline is stable: **55 fewer tokens (0.4%)**, not a doubling.

Several nearby solar-faraday sessions start around 6,790 tokens. Those are short title/utility runs, not comparable full conversation sessions. Comparing them to Main incorrectly suggests a ~2× regression.

## Attribution

A conversation prompt compiled with no capabilities is about **1,157 tokens**:

| Required layer | Estimated tokens |
| --- | ---: |
| Identity and safety | 81 |
| Conversation role | 139 |
| Engineering principles | 357 |
| Voice | 277 |
| Collaboration | 165 |
| Empty active-tool protocol | 138 |

The remaining first-turn occupancy is mostly provider-visible tool descriptions and JSON schemas. Skills are not eagerly inserted: the harness exposes a searchable map through `jingler_list_resources`, then loads one exact body through `jingler_load_resource`.

The largest avoidable prompt duplication found was the native `subagent` description. Detailed policy already exists in the active-tool protocol, but another 1,407 characters repeated it in the compiled system prompt. Native subagent definitions come from the Pi extension, so this change affects the prompt copy only and saves about **350 estimated tokens per full conversation turn**.

## Skill-map state

The live managed catalog contained:

- 503 enabled skills
- 252 unique source paths
- 251 duplicate imports
- 517,838 bytes of catalog JSON
- 252,281 bytes of `{id, kind, name, description}` metadata

An eager complete skill map would cost roughly **27K estimated tokens even after source deduplication**, so it must stay behind the harness search tool.

## Changes

- Made managed imports idempotent by resource kind + canonical source path. Re-imports now return a `duplicate` diagnostic instead of creating `-2`, `-3`, etc.
- Kept the skill map on demand, reduced its default page from 20 to 10 entries, retained an explicit 20-entry maximum, and reduced descriptions from 500 to 160 characters.
- Removed duplicated subagent policy from its capability description. The shared prompt protocol still carries the behavioral rules.

These changes live entirely in `packages/cli-adapters`, so any host using the Pi harness gets the same behavior.

## Remaining ceiling

Existing duplicate files/catalog rows are left intact to avoid silently deleting operator-approved resources. New imports no longer grow the duplicate set. Provider tool schemas remain the dominant fixed context cost; reducing that further needs capability activation/deactivation support in the harness rather than another app-specific loader.

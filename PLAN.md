# Fix stale completed subagent tabs

## Context

Completed subagent tabs can remain visible as `running` when the renderer misses the terminal fleet event. The retained Pi session is disposed as soon as its snapshot reports no active children, so later renderer reconciliation fails with `pi session is not active` instead of receiving the authoritative empty snapshot that would close the stale tab.

The intended behavior in `docs/subagent-fleet.md` is to close finished live tabs while retaining uncertain/missed completions under **Previous chats** as `unknown` rather than falsely showing them as running.

## Approach

Keep the fix in the shared renderer reconciliation path in `apps/desktop/src/renderer/use-subagent-fleet.ts`:

- Preserve the existing retries because session startup can transiently return `pi session is not active`.
- After those retries are exhausted for that specific inactive-session error, convert every locally active node to a terminal `unknown` upsert.
- Sync those recovery events through the existing fleet machine. This removes the nodes from live tabs, resets a selected stale tab to Main through existing selection logic, and makes agent nodes available in **Previous chats** through the existing completed-node projection.
- Leave unrelated snapshot failures untouched; they are not evidence that the children ended.

> [!IMPORTANT]
> Recovery must not report `completed`: the terminal event was missed, so `unknown` is the only factual state.

## Files to modify

| File | Change |
| --- | --- |
| `apps/desktop/src/renderer/use-subagent-fleet.ts` | Add bounded inactive-session fallback that settles stale active nodes as `unknown`. |
| `apps/desktop/src/renderer/use-subagent-fleet.test.tsx` | Add regression coverage for exhausted inactive-session retries and guard coverage for unrelated errors. |

## Reuse

- Reuse the active status set and `SubagentFleetEvent` upsert shape already used in `apps/desktop/src/renderer/use-subagent-fleet.ts` and `apps/desktop/src/renderer/subagent-fleet-machine.ts`.
- Reuse `completedSubagentNodes` in `apps/desktop/src/renderer/subagent-tab-store.ts`; it already classifies `unknown` as completed history.
- Reuse the fleet machine's existing terminal-selection fallback in `apps/desktop/src/renderer/use-subagent-fleet.ts`.
- Keep `PiSessionRegistry.#reconcileLifetime` and transcript archiving in `packages/cli-adapters/src/runtime/agent/pi-agent-runtime.ts` unchanged; immediate disposal is valid and the archived transcript lookup already survives disposal.

## Steps

- [x] Add a small helper in `apps/desktop/src/renderer/use-subagent-fleet.ts` that creates `unknown` terminal upserts for currently active nodes when the owning Pi session is definitively unavailable.
- [x] Invoke it only after the existing three delayed retries all fail with `pi session is not active`; reset retry state after recovery and continue normal focus/poll reconciliation.
- [x] Add a fake-timer hook test proving a stale running tab closes and appears in completed history as `unknown` after retries are exhausted.
- [x] Add or extend a test proving generic RPC failures do not settle active nodes.
- [x] Run the focused Vitest file and desktop TypeScript checks.

## Verification

1. Run the focused renderer test for `apps/desktop/src/renderer/use-subagent-fleet.test.tsx`.
2. Run the desktop package typecheck.
3. Manually simulate or reproduce a missed terminal event: after the parent runtime is disposed, confirm the child leaves live tabs after the bounded retry window, appears under **Previous chats** as `unknown`, and selecting it can still load its archived transcript.
4. Confirm a transient startup `pi session is not active` still recovers through the existing retry path without prematurely closing a real child.
5. Confirm an unrelated snapshot error leaves active tabs unchanged.

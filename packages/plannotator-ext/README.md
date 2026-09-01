# @jingler/plannotator-ext

Jingler's fork of the Plannotator Pi extension — the plan lifecycle owner for
every Jingler session. It provides file-based plan mode: the agent writes a
markdown plan and calls `plannotator_submit_plan`; the operator reviews and
approves/denies; execution continues in the same session with `[DONE:n]`
checklist progress.

Loaded raw (`.ts`, via pi's jiti loader) — no build step. Resolution is pinned
in `packages/cli-adapters/src/runtime/agent/locked-pi-resources.ts`.

State is published to the host on the `plannotator:host-state` event channel
(see `plannotator-events.ts`), consumed by
`packages/cli-adapters/src/runtime/agent/pi-session-factory.ts` and projected
into Jingler's UI. See `NOTICE.md` for fork provenance and licensing.

This package is intentionally exempt from the repo-wide `tsc --noEmit` gate:
it is forked vendored source typed against pi's own toolchain, exactly as it
was when loaded from `node_modules` — behavioural parity is guarded by the
plan-mode e2e spec instead.

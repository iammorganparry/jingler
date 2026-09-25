# Java and TypeScript semantic hover in Jingler files

## Scope

Implement the first usable multi-language slice: one shared JDT.LS client per worktree for Java, Jingler's existing TypeScript-native semantic engine for TypeScript/JavaScript, agent/UI hover through the same service, and Pierre hover in the editable file view plus the additions/current side of diffs.

Deliberate limits for this pass:
- use an installed `jdtls` executable and Java 21 from `PATH`; do not add a binary downloader yet
- no hover for deletion/old-side diff tokens
- no go-to-definition UI yet
- no automatic diagnostics injection

## Verified dependency baseline

- `@pierre/diffs`: installed/latest `1.5.1`; the old `1.3.6` editor-cache patch was removed because the fix is upstream.
- `@pierre/trees`: installed/latest `1.0.0-beta.6` — no change.
- `@pierre/theme`: installed/latest `2.0.0` — no change.
- `@pierre/theming`: resolved/latest `1.0.1` for Diffs; Trees intentionally carries `1.0.0` — no direct override.

## Plan

- [x] Upgrade `@pierre/diffs` to `1.5.1`, reconcile the local patch against the new editor implementation, and run the existing Pierre model/editor/selection tests before adding hover behavior.
- [x] Add a small workspace-scoped language-intelligence service in `@jingler/cli-adapters`: reuse the existing TypeScript-native engine and add a persistent JDT.LS client that speaks JSON-RPC over stdio, synchronizes current Java text, bounds requests, and shuts processes down cleanly; route agent Java hover through it without changing TypeScript response shape.
- [x] Add a typed, worktree-contained `Asset.hover` RPC and renderer client method for Java, TypeScript, and JavaScript; reject unsupported files/positions and return a compact nullable hover payload.
- [x] Reuse Pierre’s existing token events and debugger-tooltip pattern for Java/TypeScript/JavaScript hover in the file editor and current-side diff view, with debounce, stale-result suppression, and accessible tooltip output.
- [x] Add focused service/RPC/component tests, run affected tests plus typecheck and lint, then update this checklist with results.

## Acceptance

- Hovering a Java identifier in the file editor shows JDT.LS type/documentation.
- Hovering a TypeScript/JavaScript identifier shows the existing compiler engine's semantic type.
- Hovering an additions/context token in a supported diff queries the current worktree file; deletion-side tokens make no request.
- Agent Java `code_intelligence` hover and the file browser reuse the same worktree JDT.LS process; TypeScript/JavaScript reuse the existing compiler engine.
- Missing Java 21 or `jdtls` returns a clear, non-crashing unavailable result, while debugger hover continues to work unchanged.
- `@pierre/diffs` is on npm latest `1.5.1`; the old version-specific patch is removed with a regression check or rebased only if the regression still reproduces.

## Sources

- Pierre Diffs current docs (`1.5.1` verified from npm): https://diffs.com/docs
- Pierre releases: https://github.com/pierrecomputer/pierre/releases
- Eclipse JDT.LS: https://github.com/eclipse-jdtls/eclipse.jdt.ls
- Pi LSP adapter reference: https://github.com/nikmmd/pi-lsp-adapter

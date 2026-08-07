# @jingler/plugin-sdk

## 2.0.2

### Patch Changes

- @jingler/ui@2.0.2

## 2.0.1

### Patch Changes

- @jingler/ui@2.0.1

## 2.0.0

### Minor Changes

- 256f5a0: Plugin system: a session-mutating SDK surface, and nine adversarial-review fixes.

  - **`useSessionActions().unlinkIssue`** — the built-in Issue tab offered "unlink" and the plugin that replaced it could not, because the SDK had no way to change a session at all. The RPC and its handler survived the migration while the button did not, so the capability vanished with nothing failing. The list is deliberately one item long: a plugin _decorates_ a session, it does not drive one, and an entry earns its place only by being something the operator can reach solely through the plugin that owns the concept.
  - **Label colours are back in the GitHub Issues tab.** `IssueLabelChip` was lost in the same migration and every label rendered as an identical neutral outline — which reads as "this issue has no colour coding" rather than "the port dropped a feature". The hex is parsed and re-emitted rather than interpolated, the same rule the theme mapper follows.
  - **A crashed plugin no longer re-mounts on every render.** Both error boundaries cleared their error when `children` changed identity, which sounds like "the subtree is new" and means "anything re-rendered" — the registry rebuilds that element every pass. A deterministically-throwing plugin was therefore cleared, re-mounted and thrown again on every tick of the session pane, flickering its own failure card and filling the console. The reset is now keyed on the plugin's `id@version` and the session id.
  - **`ctx.exec` no longer kills children instantly or corrupts stdout.** `timeoutMs: 0` (or a negative, or a `NaN` out of a parsed config) scheduled the SIGKILL for the next tick, so every command died with a timeout nobody asked for; those values are now read as unset. Separately, one truncation flag was shared across both streams and its marker only ever appended to stdout — so a command with a chatty stderr and a small valid JSON stdout came back with `… output truncated` glued to the JSON. The 120s ceiling is now documented on `ExecOptions` rather than silently clamping.
  - **A consent prompt no longer clobbers a concurrent revocation.** `getSession` read the grants file, awaited an operator-paced native dialog, then wrote a list computed from that stale read. A revoke performed while the prompt was open was silently undone — restoring access the operator had just taken away.

  Also: the extension-host bundle's filename is documented correctly in `electron.vite.config.ts` (`.js`, not `.mjs` — the stale comment described the exact bug it was meant to record), `build-bundled-plugins.mjs` can run on Windows, and `@jingler/ui` stops publishing the keybinding resolver until the dispatch half that would use it lands.

### Patch Changes

- Updated dependencies [3deb8c2]
- Updated dependencies [fa256c7]
- Updated dependencies [1c93bba]
- Updated dependencies [f948464]
- Updated dependencies [1eed467]
- Updated dependencies [c1a3c18]
- Updated dependencies [df17817]
- Updated dependencies [d6dbd48]
- Updated dependencies [9d25d60]
- Updated dependencies [eeaabe2]
- Updated dependencies [59305ae]
- Updated dependencies [eed78b1]
- Updated dependencies [272f34a]
- Updated dependencies [142c0fe]
- Updated dependencies [42780c5]
- Updated dependencies [f842e84]
- Updated dependencies [37c10d5]
- Updated dependencies [ce51af4]
- Updated dependencies [af42847]
- Updated dependencies [eb62eb6]
- Updated dependencies [f3bb880]
- Updated dependencies [3dccb5c]
- Updated dependencies [a0292a3]
- Updated dependencies [abec0fa]
- Updated dependencies [256f5a0]
- Updated dependencies [09f4690]
- Updated dependencies [334ebfc]
- Updated dependencies [938dba4]
- Updated dependencies [777d6d2]
- Updated dependencies [9e2539d]
- Updated dependencies [41f0d81]
- Updated dependencies [9365e0c]
- Updated dependencies [9e2539d]
- Updated dependencies [8e9cb2a]
- Updated dependencies [b79346f]
- Updated dependencies [304ac26]
- Updated dependencies [b419734]
- Updated dependencies [f987c20]
  - @jingler/ui@2.0.0

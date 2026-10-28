/**
 * The palette's scope switch, as a tiny XState machine.
 *
 * Why this isn't just `useState`: there are two independent ways scope
 * changes — Tab cycles Workspace/Chat, and typing `>` / `@` / `#` as the FIRST
 * character jumps to a prefix scope — and they interact (a prefix scope
 * suspends the Tab cycle; Backspace on the now-empty input is what undoes a
 * prefix, not a second keystroke of the prefix character). That is state-chart
 * shaped, and spelling it as a chart rather than a pile of `if`s in the
 * component is what keeps "Backspace while a prefix is active" from drifting
 * out of sync with "Backspace while it isn't".
 */
import { assign, setup } from "xstate"
import { nextScope, type PaletteScope, scopeForPrefix } from "./command-palette-model.js"

export interface CommandPaletteContext {
  readonly scope: PaletteScope
  /** The text after the prefix, when one is active — never includes the prefix character itself. */
  readonly query: string
  /** Whether `scope` was reached via a `>` / `@` / `#` prefix rather than the Workspace/Chat switch. */
  readonly prefixActive: boolean
}

const initialContext: CommandPaletteContext = { scope: "workspace", query: "", prefixActive: false }

export type CommandPaletteEvent =
  /** The input's new full value, cmdk-style — the machine decides whether it's a prefix or ordinary text. */
  | { readonly type: "QUERY_CHANGED"; readonly value: string }
  /** Backspace pressed while the input was already empty. */
  | { readonly type: "BACKSPACE_EMPTY" }
  /** Tab: cycles Workspace/Chat. A no-op while a prefix scope is active. */
  | { readonly type: "CYCLE_SCOPE" }
  /** The Workspace/Chat switch clicked directly. */
  | { readonly type: "SET_SCOPE"; readonly scope: PaletteScope }
  /** The palette closed — scope and query are per-opening, not persistent. */
  | { readonly type: "RESET" }

export const commandPaletteMachine = setup({
  types: {
    context: {} as CommandPaletteContext,
    events: {} as CommandPaletteEvent
  }
}).createMachine({
  id: "commandPalette",
  context: initialContext,
  on: {
    QUERY_CHANGED: {
      actions: assign(({ context, event }) => {
        // A prefix only fires on the FIRST character of an otherwise-empty,
        // non-prefixed query — typing "@" after other text is a literal "@".
        if (!context.prefixActive && context.query === "" && event.value.length === 1) {
          const scope = scopeForPrefix(event.value)
          if (scope) return { scope, query: "", prefixActive: true }
        }
        return { query: event.value }
      })
    },
    BACKSPACE_EMPTY: {
      actions: assign(({ context }) =>
        context.prefixActive ? { scope: "workspace" as const, prefixActive: false } : {}
      )
    },
    CYCLE_SCOPE: {
      actions: assign(({ context }) =>
        context.prefixActive ? {} : { scope: nextScope(context.scope) }
      )
    },
    SET_SCOPE: {
      actions: assign(({ event }) => ({ scope: event.scope, prefixActive: false }))
    },
    RESET: {
      actions: assign(() => initialContext)
    }
  }
})

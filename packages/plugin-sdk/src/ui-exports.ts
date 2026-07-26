/**
 * The names `@starbase/plugin-sdk/ui` exports — as DATA, importing nothing.
 *
 * ## Why this exists
 *
 * The generated runtime shims spell out each binding, because an ES module's
 * export list has to be static. Main builds those shims, so it needs to know the
 * names — and the obvious way to learn them, `Object.keys(await import(...))`,
 * makes the MAIN PROCESS import the entire component library at startup. That
 * pulls in a syntax highlighter, a maths renderer and a graph layout engine, to
 * serve a file that is a few hundred bytes of re-exports.
 *
 * So the list lives here, in a module with no imports at all, and main reads it
 * instead. `ui-exports.test.ts` asserts it matches the real module exactly, so
 * "hand-written" costs a failing test rather than a plugin silently receiving
 * `undefined` for a component that plainly exists.
 */
export const UI_EXPORT_NAMES = [
  "Avatar",
  "Badge",
  "Callout",
  "Card",
  "CodeChip",
  "Input",
  "Kbd",
  "Markdown",
  "Pill",
  "SearchInput",
  "SegmentedControl",
  "Spinner",
  "StatusDot",
  "Toggle",
  "atLeast",
  "cn",
  "githubAvatarUrl",
  "relativeTime",
  "useWidthTier"
] as const

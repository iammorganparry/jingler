/**
 * The UI kit a plugin builds its tab out of.
 *
 * ## Why this exists at all
 *
 * The first real plugin migration found the gap immediately. A rich tab wants
 * markdown, an avatar, a spinner, relative timestamps and the responsive width
 * tier — all of which Jingler already has, and none of which a plugin could
 * reach. The two alternatives were both bad: bundle your own (a markdown
 * renderer drags in a syntax highlighter, so every plugin ships a megabyte of
 * duplicate shiki), or hand-roll flat approximations that drift out of step with
 * the app around them.
 *
 * These cost a plugin nothing at runtime. They are already in Jingler's own
 * bundle, and `@jingler/plugin-sdk` resolves — through the importmap — to the
 * app's instance of this module. A plugin importing `Markdown` gets the same
 * component the Conversation tab is using.
 *
 * ## Why it is curated rather than a re-export of everything
 *
 * `@jingler/ui` exports well over a hundred symbols, most of which are internal
 * compositions with Jingler-specific props — a session row, a plan flow, a PR
 * timeline entry. Re-exporting the lot would make every one of them a public API
 * that could not be reshaped without breaking plugins.
 *
 * What is here is the set that is genuinely generic: primitives with no
 * knowledge of sessions, plans or pull requests. Anything a plugin can only use
 * by knowing Jingler's internal shapes is deliberately left out.
 *
 * ## Theming comes free, and is not optional
 *
 * Every component here draws from `--sb-*` tokens. That is the practical reason
 * to use them rather than raw elements: a tab built from these is correct in all
 * nine bundled themes and in whatever the operator drops into `~/jingler/themes`
 * next, without the author testing any of them.
 */

// ── Layout and text ──────────────────────────────────────────────────────────

/** `clsx` + `tailwind-merge`, so conditional classes collapse correctly. */
export { cn } from "@jingler/ui"

/**
 * The responsive tier of the PANE a plugin is rendering in — not the window.
 *
 * A four-way split on a 4K display gives every pane a `narrow` tier; a maximised
 * pane on a laptop gives `wide`. Keying off the window gets both backwards, and
 * a plugin tab is subject to exactly the same split as a built-in one.
 */
export { useWidthTier, atLeast } from "@jingler/ui"

// ── Primitives ───────────────────────────────────────────────────────────────

export { Badge } from "@jingler/ui"
export { Pill } from "@jingler/ui"
export { Spinner } from "@jingler/ui"
export { Avatar, githubAvatarUrl } from "@jingler/ui"
// GitHub-shaped, like `githubAvatarUrl` above. The kit is curated, not generic:
// a plugin rendering issues should not have to reimplement the chip the app
// already draws — the one copy that existed drifted by a font size immediately.
export { IssueLabelChip } from "@jingler/ui"
export { Callout } from "@jingler/ui"
export { Card } from "@jingler/ui"
export { Input } from "@jingler/ui"
export { SearchInput } from "@jingler/ui"
export { Toggle } from "@jingler/ui"
export { SegmentedControl } from "@jingler/ui"
export { StatusDot } from "@jingler/ui"
export { Kbd } from "@jingler/ui"
export { CodeChip } from "@jingler/ui"

/**
 * Markdown with the app's own renderer — syntax highlighting, math, the lot.
 *
 * The single strongest reason this module exists: a plugin rendering an issue
 * body, a changelog or a README would otherwise bundle a highlighter of its own.
 */
export { Markdown } from "@jingler/ui"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "2 hours ago", formatted the way the rest of the app formats it. */
export { relativeTime } from "@jingler/ui"

/**
 * The UI kit a plugin builds its tab out of.
 *
 * ## Why this exists at all
 *
 * The first real plugin migration found the gap immediately. A rich tab wants
 * markdown, an avatar, a spinner, relative timestamps and the responsive width
 * tier — all of which Starbase already has, and none of which a plugin could
 * reach. The two alternatives were both bad: bundle your own (a markdown
 * renderer drags in a syntax highlighter, so every plugin ships a megabyte of
 * duplicate shiki), or hand-roll flat approximations that drift out of step with
 * the app around them.
 *
 * These cost a plugin nothing at runtime. They are already in Starbase's own
 * bundle, and `@starbase/plugin-sdk` resolves — through the importmap — to the
 * app's instance of this module. A plugin importing `Markdown` gets the same
 * component the Conversation tab is using.
 *
 * ## Why it is curated rather than a re-export of everything
 *
 * `@starbase/ui` exports well over a hundred symbols, most of which are internal
 * compositions with Starbase-specific props — a session row, a plan flow, a PR
 * timeline entry. Re-exporting the lot would make every one of them a public API
 * that could not be reshaped without breaking plugins.
 *
 * What is here is the set that is genuinely generic: primitives with no
 * knowledge of sessions, plans or pull requests. Anything a plugin can only use
 * by knowing Starbase's internal shapes is deliberately left out.
 *
 * ## Theming comes free, and is not optional
 *
 * Every component here draws from `--sb-*` tokens. That is the practical reason
 * to use them rather than raw elements: a tab built from these is correct in all
 * nine bundled themes and in whatever the operator drops into `~/starbase/themes`
 * next, without the author testing any of them.
 */

// ── Layout and text ──────────────────────────────────────────────────────────

/** `clsx` + `tailwind-merge`, so conditional classes collapse correctly. */
export { cn } from "@starbase/ui"

/**
 * The responsive tier of the PANE a plugin is rendering in — not the window.
 *
 * A four-way split on a 4K display gives every pane a `narrow` tier; a maximised
 * pane on a laptop gives `wide`. Keying off the window gets both backwards, and
 * a plugin tab is subject to exactly the same split as a built-in one.
 */
export { useWidthTier, atLeast } from "@starbase/ui"

// ── Primitives ───────────────────────────────────────────────────────────────

export { Badge } from "@starbase/ui"
export { Pill } from "@starbase/ui"
export { Spinner } from "@starbase/ui"
export { Avatar, githubAvatarUrl } from "@starbase/ui"
export { Callout } from "@starbase/ui"
export { Card } from "@starbase/ui"
export { Input } from "@starbase/ui"
export { SearchInput } from "@starbase/ui"
export { Toggle } from "@starbase/ui"
export { SegmentedControl } from "@starbase/ui"
export { StatusDot } from "@starbase/ui"
export { Kbd } from "@starbase/ui"
export { CodeChip } from "@starbase/ui"

/**
 * Markdown with the app's own renderer — syntax highlighting, math, the lot.
 *
 * The single strongest reason this module exists: a plugin rendering an issue
 * body, a changelog or a README would otherwise bundle a highlighter of its own.
 */
export { Markdown } from "@starbase/ui"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "2 hours ago", formatted the way the rest of the app formats it. */
export { relativeTime } from "@starbase/ui"

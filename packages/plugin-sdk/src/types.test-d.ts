/**
 * Type-level tests for the SDK's public surface.
 *
 * These are not belt-and-braces. The guarantees in `define.ts` live ENTIRELY in
 * the type system — both functions return their input at runtime — so a
 * regression here is invisible to every runtime test in the repo. The `const`
 * modifier silently disappearing, or a type widening to `string`, would leave
 * `definePlugin` accepting any object at all while every other test still
 * passed.
 *
 * Checked by `tsc --noEmit` as part of the package's typecheck. A `@ts-expect-error`
 * that STOPS erroring fails the build, which is what makes the negative cases
 * real assertions rather than comments.
 */
import { expectTypeOf } from "expect-type"
import type { ComponentType } from "react"
import {
  defineManifest,
  definePlugin,
  type CommandIdsOf,
  type ContributionId,
  type IdOf,
  type TabIdsOf,
  type TabProps
} from "./define.js"
import type { HostContext } from "./host.js"
import type { PluginStorage, SessionSnapshot } from "./common.js"

const View: ComponentType<TabProps> = () => null

// ── Literal capture ─────────────────────────────────────────────────────────

const manifest = defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  ui: "dist/ui.js",
  activationEvents: ["onTab:linear.issues"],
  contributes: {
    tabs: [
      { id: "linear.issues", label: "Issues", icon: "CircleDot" },
      { id: "linear.cycles", label: "Cycles" }
    ],
    commands: [{ id: "linear.sync", title: "Sync Linear" }]
  }
})

// The whole design rests on this: without `const` these widen to `string` and
// every guarantee below silently becomes `Record<string, unknown>`.
expectTypeOf<IdOf<typeof manifest>>().toEqualTypeOf<"linear">()
expectTypeOf<TabIdsOf<typeof manifest>>().toEqualTypeOf<"linear.issues" | "linear.cycles">()
expectTypeOf<CommandIdsOf<typeof manifest>>().toEqualTypeOf<"linear.sync">()
expectTypeOf<ContributionId<typeof manifest>>().toEqualTypeOf<`linear.${string}`>()

// Not `string`. If this ever passes, autocomplete is dead and so is every check.
expectTypeOf<TabIdsOf<typeof manifest>>().not.toEqualTypeOf<string>()

// ── definePlugin demands exactly the declared views ──────────────────────────

definePlugin(manifest, {
  views: { "linear.issues": View, "linear.cycles": View }
})

// Declared a tab, shipped no view for it — the mismatch that would otherwise
// present as a tab that opens onto an empty pane.
// @ts-expect-error missing "linear.cycles"
definePlugin(manifest, { views: { "linear.issues": View } })

// @ts-expect-error missing both declared views
definePlugin(manifest, { views: {} })

// A view for a tab that was never declared. Rejected because a plugin that
// could register an undeclared contribution would make the Settings enable
// switch advisory.
definePlugin(manifest, {
  views: {
    "linear.issues": View,
    "linear.cycles": View,
    // @ts-expect-error "linear.unknown" is not a declared tab
    "linear.unknown": View
  }
})

// A component whose props are not TabProps.
definePlugin(manifest, {
  views: {
    "linear.issues": View,
    // @ts-expect-error a tab view receives TabProps, not arbitrary props
    "linear.cycles": (props: { unrelated: number }) => null
  }
})

// ── Namespacing is enforced on the manifest itself ───────────────────────────

// The directive sits on the CALL, not on the offending property: the check is a
// constraint on the whole argument, so that is where TypeScript reports it. The
// error text itself names the required prefix — see `NamespaceCheck`.

// @ts-expect-error contribution ids must start with "linear."
defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  contributes: { tabs: [{ id: "jira.issues", label: "Issues" }] }
})

// @ts-expect-error a bare id is not namespaced
defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  contributes: { tabs: [{ id: "issues", label: "Issues" }] }
})

// Commands are checked by the same rule, not just tabs.
// @ts-expect-error command ids must start with "linear." too
defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  contributes: { commands: [{ id: "other.sync", title: "Sync" }] }
})

// A plugin contributing nothing is legal — a host-only plugin has no views.
const hostOnly = defineManifest({
  id: "watcher",
  name: "Watcher",
  version: "0.1.0",
  main: "dist/main.js",
  activationEvents: ["onStartupFinished"]
})
expectTypeOf<TabIdsOf<typeof hostOnly>>().toEqualTypeOf<never>()
definePlugin(hostOnly, { views: {} })

// ── Required manifest fields ────────────────────────────────────────────────

// @ts-expect-error `version` is required
defineManifest({ id: "linear", name: "Linear" })

defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  // @ts-expect-error activation events are a closed set
  activationEvents: ["onStartup"]
})

// ── Nothing in the public surface is `any` ───────────────────────────────────

expectTypeOf<TabProps["session"]>().toEqualTypeOf<SessionSnapshot>()
expectTypeOf<TabProps["session"]>().not.toBeAny()
expectTypeOf<TabProps["pluginId"]>().toEqualTypeOf<string>()

// `SessionSnapshot` is the deliberately small subset a plugin may couple to. If
// Jingler's internal `Session` ever leaks in here, this catches it.
expectTypeOf<SessionSnapshot["prNumber"]>().toEqualTypeOf<number | null>()
expectTypeOf<SessionSnapshot>().not.toBeAny()

expectTypeOf<HostContext>().not.toBeAny()
expectTypeOf<HostContext["storage"]>().toEqualTypeOf<PluginStorage>()

// Storage reads are typed by the caller's expectation, and async on both sides.
expectTypeOf<PluginStorage["get"]>().returns.resolves.not.toBeAny()

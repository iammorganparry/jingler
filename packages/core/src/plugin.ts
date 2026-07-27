/**
 * Plugins — the manifest on disk, and what Jingler folds it down to.
 *
 * ## Why the shape mirrors VS Code
 *
 * The people who will write Jingler plugins have written VS Code extensions.
 * Every concept below — `activationEvents`, `contributes`, `extensionKind`,
 * `capabilities`, `extensionDependencies` — is named the way VS Code names it,
 * because a plugin author who already knows that vocabulary should not have to
 * learn a second one to say the same thing. Where Jingler has no equivalent
 * noun the name is translated rather than invented (`untrustedWorkspaces`
 * becomes `untrustedRepos`), and where Jingler has a surface VS Code lacks
 * (session tabs, split panes) the contribution point is new.
 *
 * ## Why there is no `permissions: ["git", "gh"]`
 *
 * The obvious design is a static array of capability flags in the manifest, and
 * it is wrong for the case that matters most: a plugin that talks to a real
 * GitHub account. A coarse `"gh"` flag answers "may this plugin run gh?" when
 * the question the operator actually needs answered is "which account, with
 * which scopes, and can I take it back?" — and a flag can express none of that.
 *
 * So sensitive access works the way it does in VS Code: the plugin asks, at the
 * moment it needs it, through {@link AuthSessionRequest} —
 * `authentication.getSession("github", ["repo"])`. The operator sees a prompt
 * naming that plugin, that provider and those scopes, grants once, and can
 * revoke later from Settings. The token lives in the extension host and is
 * never part of any payload the renderer can see (see {@link AuthSessionInfo},
 * which deliberately has no token field).
 *
 * The consequence worth stating plainly: the official GitHub plugin holds no
 * privilege a third-party GitHub plugin could not also request. That is the
 * only honest test of whether this API is real rather than decorative.
 *
 * ## What this file is NOT
 *
 * It is not a sandbox. Plugin UI is ES modules loaded into the renderer's own
 * realm and plugin backends are Node with full access — the same position VS
 * Code takes. What is enforceable lives at the extension-host boundary: lazy
 * activation, consent before credentials, revocable grants. Everything here is
 * a description of intent that the host then holds the plugin to; none of it is
 * a wall around untrusted code, and `docs/plugins/permissions-and-trust.md`
 * says so in those words.
 */
import { Schema } from "effect"

// ── Identifiers ──────────────────────────────────────────────────────────────

/**
 * A plugin's id — lowercase kebab, and the namespace every one of its
 * contributions must sit under.
 *
 * Constrained rather than left free-form because the id is also a directory
 * name under `~/jingler/plugins` and a path segment in `jingler-plugin://`
 * URLs. Allowing dots, slashes or uppercase would make `../../etc` and
 * case-insensitive-filesystem collisions expressible at the schema level, and
 * the loader would be left to catch at runtime what the type could have refused
 * outright.
 */
export const PluginId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]*$/, {
    identifier: "PluginId",
    description: "lowercase kebab-case, e.g. github-pull-requests"
  })
)
export type PluginId = Schema.Schema.Type<typeof PluginId>

/**
 * A contribution's id — `<pluginId>.<local>`, e.g. `linear.issues`.
 *
 * Namespacing is mandatory and checked twice: the pattern here proves the shape,
 * and {@link PluginManifest}'s filter proves the prefix actually matches the
 * declaring plugin. Two plugins both contributing a tab called `issues` is the
 * expected case, not the exotic one, and an un-namespaced id would make the
 * second one silently shadow the first.
 */
export const ContributionId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/, {
    identifier: "ContributionId",
    description: "namespaced as <pluginId>.<local>, e.g. linear.issues"
  })
)
export type ContributionId = Schema.Schema.Type<typeof ContributionId>

// ── Activation ───────────────────────────────────────────────────────────────

/**
 * What wakes a dormant plugin.
 *
 * Plugins are not imported at boot. Ten installed plugins that each spend 200ms
 * in `activate()` would put two seconds on startup for work the operator may
 * never ask for, so a plugin stays a manifest entry until one of its declared
 * events fires — the operator opens its tab, runs its command, or the repo it
 * cares about is the one on screen.
 *
 * A manifest with no `activationEvents` never activates its host half. That is
 * legal and correct for a pure-UI plugin: it still contributes tabs, they still
 * render, and no Node process is ever started on its behalf.
 *
 * - `onStartupFinished` — after the window is interactive. The escape hatch for
 *   plugins that genuinely must observe from the start; costs startup budget,
 *   so the docs push authors to a narrower event first.
 * - `onCommand:<contributionId>` — the operator ran that command.
 * - `onTab:<contributionId>` — the operator opened that tab.
 * - `repoContains:<glob>` — a file matching the glob exists in the active
 *   session's repo, e.g. `repoContains:Cargo.toml`.
 */
export const ActivationEvent = Schema.String.pipe(
  Schema.pattern(
    /^(?:onStartupFinished|onCommand:[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*|onTab:[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*|repoContains:.+)$/,
    {
      identifier: "ActivationEvent",
      description:
        "onStartupFinished, onCommand:<id>, onTab:<id>, or repoContains:<glob>"
    }
  )
)
export type ActivationEvent = Schema.Schema.Type<typeof ActivationEvent>

/**
 * Where a plugin's halves are allowed to run.
 *
 * `ui` is the renderer-side ES module, `host` the extension-host entry. Declared
 * rather than inferred from which files exist so that a plugin shipping a
 * `main.js` it no longer activates fails review instead of quietly starting a
 * process nobody asked for.
 */
export const ExtensionKind = Schema.Literal("ui", "host")
export type ExtensionKind = Schema.Schema.Type<typeof ExtensionKind>

// ── Contribution points ──────────────────────────────────────────────────────

/**
 * When a tab should appear for a session.
 *
 * A closed set rather than a predicate string, because the renderer evaluates
 * this for every session on every render and an author-supplied expression
 * language would be both a performance question and a parser to maintain.
 * A plugin needing finer control ships a `when` function in its UI module; this
 * field is the cheap pre-filter that decides whether the module is even asked.
 */
export const TabVisibility = Schema.Literal(
  "always",
  "hasPr",
  "hasWorktree",
  "hasIssue"
)
export type TabVisibility = Schema.Schema.Type<typeof TabVisibility>

/**
 * A tab in a session pane, beside Conversation, Changes and the rest.
 *
 * `icon` is a lucide icon name resolved host-side rather than an image path or
 * a component: the tab bar renders at one size in one colour taken from the
 * active theme, and letting a plugin supply artwork would mean plugin tabs are
 * the only ones that stop matching when the operator switches theme.
 */
export const TabContribution = Schema.Struct({
  id: ContributionId,
  label: Schema.String,
  /** A lucide icon name, e.g. `GitPullRequest`. Unknown names fall back. */
  icon: Schema.optional(Schema.String),
  /** Lower sorts earlier. Built-ins occupy 0–99; plugins default to 100. */
  order: Schema.optional(Schema.Number),
  when: Schema.optional(TabVisibility)
})
export type TabContribution = Schema.Schema.Type<typeof TabContribution>

/** Which edge of the shell a contributed pane docks to. */
export const PaneSlot = Schema.Literal("right", "bottom")
export type PaneSlot = Schema.Schema.Type<typeof PaneSlot>

/**
 * A dock pane, mounted once for the window beside the terminal and browser
 * preview — not once per split pane.
 *
 * The distinction matters and is the reason this is a separate contribution
 * point rather than a flag on {@link TabContribution}: a tab belongs to a
 * session and there may be four on screen, whereas a dock is a property of the
 * window. Modelling a dock as a tab would mean four copies of a plugin's
 * process-wide panel fighting over the same state.
 */
export const PaneContribution = Schema.Struct({
  id: ContributionId,
  label: Schema.String,
  icon: Schema.optional(Schema.String),
  slot: PaneSlot,
  /** Initial size along the docked axis, in px. The operator can resize. */
  defaultSize: Schema.optional(Schema.Number)
})
export type PaneContribution = Schema.Schema.Type<typeof PaneContribution>

/** An entry in the command palette, dispatched to the extension host. */
export const CommandContribution = Schema.Struct({
  id: ContributionId,
  title: Schema.String,
  /** Groups the command in the palette, e.g. "GitHub". */
  category: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String)
})
export type CommandContribution = Schema.Schema.Type<typeof CommandContribution>

/**
 * A keyboard chord a plugin would like to own.
 *
 * A *request*, not a grant. Built-in chords win every collision, and the loader
 * reports the loss rather than silently dropping it — a plugin whose shortcut
 * quietly does nothing is indistinguishable to the operator from a plugin that
 * is broken.
 */
export const KeybindingContribution = Schema.Struct({
  command: ContributionId,
  /** A chord in the app's existing notation, e.g. `ctrl+shift+l`. */
  key: Schema.String,
  mac: Schema.optional(Schema.String)
})
export type KeybindingContribution = Schema.Schema.Type<
  typeof KeybindingContribution
>

/** The value shape a contributed setting holds. */
export const SettingType = Schema.Literal("string", "number", "boolean", "enum")
export type SettingType = Schema.Schema.Type<typeof SettingType>

/**
 * A setting rendered into Settings as a generated form row.
 *
 * Generated rather than plugin-drawn so that every plugin's settings look like
 * every other plugin's and like Jingler's own — a plugin cannot ship a
 * settings pane that ignores the theme, because it does not ship one at all.
 */
export const SettingContribution = Schema.Struct({
  id: ContributionId,
  label: Schema.String,
  type: SettingType,
  description: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Unknown),
  /** Required when `type` is `enum`; ignored otherwise. */
  options: Schema.optional(Schema.Array(Schema.String))
})
export type SettingContribution = Schema.Schema.Type<typeof SettingContribution>

/**
 * An authentication provider the plugin itself implements.
 *
 * This is what makes "extend the app with your favourite apps" reach past the
 * services Jingler happens to know about: a self-hosted GitLab, an internal
 * issue tracker or a corporate SSO is a plugin contributing a provider, and
 * every other plugin can then ask it for sessions through exactly the same
 * `getSession` call it would use for the built-in `github` provider.
 *
 * Declaring a provider the module does not implement is a load-time failure,
 * not a first-use one — the operator should learn that a plugin is broken when
 * they install it, not three days later at the moment they needed it.
 */
export const AuthProviderContribution = Schema.Struct({
  /** Bare, not namespaced — providers are addressed globally, e.g. `github`. */
  id: Schema.String.pipe(
    Schema.pattern(/^[a-z0-9][a-z0-9-]*$/, { identifier: "AuthProviderId" })
  ),
  label: Schema.String,
  /** Scopes this provider understands, shown in the consent prompt. */
  scopes: Schema.optional(Schema.Array(Schema.String))
})
export type AuthProviderContribution = Schema.Schema.Type<
  typeof AuthProviderContribution
>

/** Everything a plugin can add to the app. */
export const PluginContributes = Schema.Struct({
  tabs: Schema.optional(Schema.Array(TabContribution)),
  panes: Schema.optional(Schema.Array(PaneContribution)),
  commands: Schema.optional(Schema.Array(CommandContribution)),
  keybindings: Schema.optional(Schema.Array(KeybindingContribution)),
  settings: Schema.optional(Schema.Array(SettingContribution)),
  authenticationProviders: Schema.optional(
    Schema.Array(AuthProviderContribution)
  )
})
export type PluginContributes = Schema.Schema.Type<typeof PluginContributes>

// ── Trust ────────────────────────────────────────────────────────────────────

/**
 * What a plugin does in a repo the operator has not marked trusted.
 *
 * VS Code's `capabilities.untrustedWorkspaces`, renamed to Jingler's noun. The
 * threat is concrete: a session is a checkout of someone else's code, and a
 * plugin that reads `.jingler/config` or runs a repo-local binary is executing
 * a stranger's intent. Declaring `limited` and naming the contributions that go
 * quiet is how a plugin says "I am still useful here, but I will not do that
 * part."
 */
export const UntrustedRepoSupport = Schema.Struct({
  supported: Schema.Union(Schema.Boolean, Schema.Literal("limited")),
  /** Shown to the operator when they are asked to trust a repo. */
  description: Schema.optional(Schema.String),
  /** Contribution ids that stay inert until the repo is trusted. */
  restrictedContributions: Schema.optional(Schema.Array(ContributionId))
})
export type UntrustedRepoSupport = Schema.Schema.Type<
  typeof UntrustedRepoSupport
>

export const PluginCapabilities = Schema.Struct({
  untrustedRepos: Schema.optional(UntrustedRepoSupport)
})
export type PluginCapabilities = Schema.Schema.Type<typeof PluginCapabilities>

// ── Authentication ───────────────────────────────────────────────────────────

/**
 * A plugin asking for credentials — the thing a `permissions` array could not
 * express.
 *
 * Identity is the triple (plugin, provider, scopes). Widening scopes is a new
 * request and prompts again, because a plugin granted `repo` last week must not
 * be able to quietly start asking for `admin:org`.
 */
export const AuthSessionRequest = Schema.Struct({
  pluginId: PluginId,
  providerId: Schema.String,
  scopes: Schema.Array(Schema.String)
})
export type AuthSessionRequest = Schema.Schema.Type<typeof AuthSessionRequest>

/**
 * What the renderer is allowed to know about a granted session.
 *
 * There is no `accessToken` field, and its absence is the point. Settings needs
 * to list and revoke grants, which needs names and dates; it never needs the
 * secret. Tokens stay in the extension host, so a compromised or merely careless
 * renderer surface — a log line, a crash report, a devtools inspection — cannot
 * leak one.
 */
export const AuthSessionInfo = Schema.Struct({
  pluginId: PluginId,
  providerId: Schema.String,
  /** Human-readable account label, e.g. a GitHub login. */
  account: Schema.optional(Schema.String),
  scopes: Schema.Array(Schema.String),
  grantedAt: Schema.String
})
export type AuthSessionInfo = Schema.Schema.Type<typeof AuthSessionInfo>

// ── SDK compatibility ────────────────────────────────────────────────────────

/**
 * The plugin API generation this app implements.
 *
 * A single integer, not a semver range, because the only question worth asking
 * is "does this plugin speak the API I have?" and the only two useful answers
 * are yes and no. A range invites authors to reason about which patch of the
 * host they need, which they cannot test and Jingler cannot promise.
 *
 * ## When to bump this
 *
 * Only on a BREAKING change to what a plugin sees: removing or renaming an
 * export, changing a `HostContext` method's signature, changing what
 * `definePlugin` returns. Adding a new hook, a new contribution point or a new
 * optional manifest field is not breaking and must not bump it — every existing
 * plugin still works, and bumping would refuse them all for nothing.
 *
 * Adding `panes` to `definePlugin` is the worked example: purely additive, so
 * this stayed at 1.
 */
export const PLUGIN_API_VERSION = 1

/**
 * Manifest field: the API generation a plugin was built against.
 *
 * Optional, and its absence means "assume the current generation". That is
 * deliberately the lenient reading: every plugin written before this field
 * existed omits it, and refusing those would break the plugins this field was
 * added to protect. A plugin that opts IN gets a clear refusal instead of a
 * runtime crash; one that does not is exactly as exposed as it was before.
 */
export const PluginApiVersion = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(1),
  Schema.annotations({
    identifier: "PluginApiVersion",
    description:
      "The Jingler plugin API generation this plugin targets. Omit to mean 'the current one'."
  })
)

// ── The manifest ─────────────────────────────────────────────────────────────

const PluginManifestFields = Schema.Struct({
  id: PluginId,
  name: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.optional(Schema.String),
  publisher: Schema.optional(Schema.String),
  /**
   * The plugin API generation this plugin targets. See
   * {@link PLUGIN_API_VERSION}. Omit to mean "whatever this app implements".
   */
  apiVersion: Schema.optional(PluginApiVersion),
  /** ESM entry for the renderer half, relative to the plugin directory. */
  ui: Schema.optional(Schema.String),
  /** Entry for the extension-host half, relative to the plugin directory. */
  main: Schema.optional(Schema.String),
  extensionKind: Schema.optional(Schema.Array(ExtensionKind)),
  activationEvents: Schema.optional(Schema.Array(ActivationEvent)),
  /** Other plugin ids that must load first. Cycles are a load failure. */
  extensionDependencies: Schema.optional(Schema.Array(PluginId)),
  capabilities: Schema.optional(PluginCapabilities),
  contributes: Schema.optional(PluginContributes)
})

/** Every contribution id a manifest declares, across all contribution points. */
const contributionIds = (
  m: Schema.Schema.Type<typeof PluginManifestFields>
): ReadonlyArray<string> => {
  const c = m.contributes
  if (!c) return []
  return [
    ...(c.tabs ?? []).map((t) => t.id),
    ...(c.panes ?? []).map((p) => p.id),
    ...(c.commands ?? []).map((x) => x.id),
    ...(c.settings ?? []).map((s) => s.id)
  ]
}

/**
 * A plugin's `jingler.plugin.json`, verbatim.
 *
 * The two cross-field rules live here rather than in the loader because both
 * describe the manifest being wrong, not the environment being wrong, and a
 * rule enforced at the schema boundary is one the generated JSON Schema can
 * also teach an editor. Everything the loader checks instead — the entry file
 * existing, dependencies resolving, the UI module exporting what it promised —
 * genuinely needs the filesystem.
 */
export const PluginManifest = PluginManifestFields.pipe(
  Schema.filter((m) => {
    const foreign = contributionIds(m).find(
      (id) => id.slice(0, id.indexOf(".")) !== m.id
    )
    if (foreign) {
      return `contribution "${foreign}" must be namespaced under the plugin id "${m.id}"`
    }

    const declared = new Set(contributionIds(m))
    const orphan = (m.contributes?.keybindings ?? []).find(
      (k) => !declared.has(k.command)
    )
    if (orphan) {
      return `keybinding "${orphan.key}" targets "${orphan.command}", which this plugin does not contribute`
    }

    return true
  })
)
export type PluginManifest = Schema.Schema.Type<typeof PluginManifest>

// ── What the loader produces ─────────────────────────────────────────────────

/** Why a plugin directory did not become a usable plugin. */
export const PluginFailureKind = Schema.Literal(
  "manifest-missing",
  "manifest-invalid",
  "dependency-missing",
  "dependency-cycle",
  "entry-missing"
)
export type PluginFailureKind = Schema.Schema.Type<typeof PluginFailureKind>

/**
 * One plugin that failed to load.
 *
 * Carried in the catalog beside the plugins that worked, rather than thrown,
 * for the reason `ThemeService` keeps a `skipped` list: one broken file must
 * never empty the set. It also means Settings can show the operator the actual
 * decode message, which is the difference between "my plugin does not appear"
 * and "line 4: `activationEvents` has an unknown event".
 */
export const PluginLoadFailure = Schema.Struct({
  /** The directory name — the manifest may not have parsed far enough for an id. */
  dir: Schema.String,
  kind: PluginFailureKind,
  message: Schema.String
})
export type PluginLoadFailure = Schema.Schema.Type<typeof PluginLoadFailure>

/** A plugin the registry accepted, with the state the UI needs to show it. */
export const LoadedPlugin = Schema.Struct({
  manifest: PluginManifest,
  /** Absolute path to the plugin's directory, always under `pluginsDir`. */
  dir: Schema.String,
  enabled: Schema.Boolean,
  /** Whether the extension-host half has been activated yet. */
  activated: Schema.Boolean,
  /** Set when `activate()` threw — the plugin loaded but its host half is dead. */
  activationError: Schema.optional(Schema.String),
  /** True for plugins seeded from app resources, e.g. the GitHub PR plugin. */
  builtin: Schema.Boolean
})
export type LoadedPlugin = Schema.Schema.Type<typeof LoadedPlugin>

/**
 * The whole plugin set, re-emitted in full on every change.
 *
 * A snapshot rather than a delta, for the same reason the theme catalog is: the
 * renderer's job becomes "render this", with no accumulated state to drift out
 * of sync with disk when an event is missed or arrives twice.
 */
export const PluginCatalog = Schema.Struct({
  plugins: Schema.Array(LoadedPlugin),
  failed: Schema.Array(PluginLoadFailure)
})
export type PluginCatalog = Schema.Schema.Type<typeof PluginCatalog>

/**
 * Raised when a plugin operation fails — install, uninstall, activation,
 * command dispatch, or a denied capability.
 *
 * A `Schema.TaggedError` because it is the error channel for the `Plugins.*`
 * RPCs and must survive encoding across the IPC boundary.
 */
export class PluginError extends Schema.TaggedError<PluginError>()(
  "PluginError",
  {
    pluginId: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

// ── What the host pushes back ─────────────────────────────────────────────────

/**
 * A message from the extension host to the renderer, carried on the single
 * `Plugins.events` stream rather than a channel per plugin.
 *
 * One multiplexed stream, not one per plugin, because the renderer subscribes
 * once for the whole window and the host activates plugins lazily: a per-plugin
 * stream would have to be opened at the exact moment a plugin first activates,
 * which is a race the renderer cannot win. Tagging each event with its
 * `pluginId` lets the renderer fan them back out itself.
 *
 * The three arms are the only things a plugin's host half can say to the UI that
 * are not a direct reply to a command:
 *
 * - `Emitted` — the plugin published on one of its own topics (its UI half
 *   subscribed to that topic). `payload` is opaque: it is the plugin's own data,
 *   and Jingler neither reads nor validates it beyond "it is JSON".
 * - `Activated` — the host half finished `activate()`, so any UI waiting on
 *   "is my backend live yet?" can proceed.
 * - `ActivationFailed` — `activate()` threw. Carried as an event rather than
 *   failing a call because activation is lazy and nobody is awaiting it; the
 *   renderer surfaces the message so a dead host half is visible, not silent.
 *
 * A `Schema.Union` of `TaggedStruct`s so the renderer discriminates on `_tag`,
 * matching every other event union in the domain (`StreamEvent`, `ContentPart`).
 */
export const PluginEvent = Schema.Union(
  Schema.TaggedStruct("Emitted", {
    pluginId: PluginId,
    /** The plugin-defined channel this was published on, e.g. `issues.changed`. */
    topic: Schema.String,
    /** The plugin's own data. Opaque to Jingler — never read, only forwarded. */
    payload: Schema.Unknown
  }),
  Schema.TaggedStruct("Activated", {
    pluginId: PluginId
  }),
  Schema.TaggedStruct("ActivationFailed", {
    pluginId: PluginId,
    message: Schema.String
  })
)
export type PluginEvent = Schema.Schema.Type<typeof PluginEvent>

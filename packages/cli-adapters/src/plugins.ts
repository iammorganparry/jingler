/**
 * Owns `~/starbase/plugins` — the stateful half of the plugin system.
 *
 * `@starbase/core`'s `plugin.ts` is pure: it says what a `starbase.plugin.json`
 * is and what a loaded plugin folds down to. This service is everything that
 * touches disk — enumerating what is installed, deciding a load order, toggling
 * a plugin off, copying one in, and noticing when the directory changes on disk.
 *
 * It is deliberately a close copy of `ThemeService`, because the two problems
 * are the same problem: a directory of independent, user-supplied files, one of
 * which being malformed must never break the rest.
 *
 * ## Listing never fails
 *
 * `list()` returns a `PluginCatalog` with a `failed` array rather than an error
 * channel. One plugin with a broken manifest, a missing entry file or a
 * dependency cycle lands in `failed` beside the plugins that loaded — the
 * operator keeps every working plugin AND is told, per directory, exactly what
 * went wrong. An error channel could only do the second, and only for the first
 * failure. Everything that MUTATES on the operator's behalf — `setEnabled`,
 * `uninstall`, `installFromFolder` — does use `PluginError`, because there the
 * failure is about one named thing they just asked for.
 *
 * ## What this service does NOT do
 *
 * It does not activate anything. Activation, command dispatch, the host→renderer
 * event stream, per-plugin storage and credential grants are the extension
 * host's job (a separate service); this one only produces the catalog the UI
 * renders and the config the host reads. So every `LoadedPlugin` it emits has
 * `activated: false` — the registry knows a plugin exists and is enabled; it
 * does not know whether its Node half is running.
 */
import { FileSystem, Path } from "@effect/platform"
import type { LoadedPlugin, PluginCatalog, PluginFailureKind, PluginLoadFailure, PluginManifest } from "@starbase/core"
import { PluginError, PluginManifest as PluginManifestSchema } from "@starbase/core"
import { Effect, ParseResult, Schema, Stream } from "effect"
import { ArrayFormatter } from "effect/ParseResult"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"

/** The one file that makes a directory a plugin. */
const MANIFEST_FILE = "starbase.plugin.json"

type PluginEnv = FileSystem.FileSystem | Path.Path | AppPaths | ConfigService

/**
 * How long to wait after a filesystem event before re-scanning the directory.
 *
 * The same reasoning as `ThemeService`'s debounce: installing or editing a
 * plugin is not one write. A copy lands many files, an editor saves a manifest
 * as a rename-plus-write, and without a settle window the app rebuilds the
 * catalog several times per change and at least one of those scans catches a
 * half-written manifest and reports it as invalid.
 */
const WATCH_DEBOUNCE_MS = 200

/** A manifest that decoded, paired with the absolute directory it came from. */
interface DecodedPlugin {
  readonly dir: string
  readonly manifest: PluginManifest
  /** True for a plugin shipped inside the app rather than installed by hand. */
  readonly builtin: boolean
}

export class PluginRegistry extends Effect.Service<PluginRegistry>()("@starbase/PluginRegistry", {
  accessors: true,
  sync: () => {
    const pluginsDir = Effect.gen(function* () {
      const paths = yield* AppPaths
      return paths.pluginsDir
    })

    /**
     * Where plugins that SHIP WITH the app live.
     *
     * Official plugins are read from the app bundle rather than copied into
     * `~/starbase/plugins` on first run. Copying would mean an upgrade silently
     * leaves the old version in place — the operator's directory is theirs, and
     * Starbase writing into it is a surprise that only shows up as a plugin
     * that stopped matching its own release notes.
     *
     * Undefined outside a packaged build, where there is nothing bundled yet.
     */
    const builtinDir = Effect.gen(function* () {
      const paths = yield* AppPaths
      return paths.builtinPluginsDir
    })

    const pluginStorageDir = Effect.gen(function* () {
      const paths = yield* AppPaths
      return paths.pluginStorageDir
    })

    /**
     * Resolve one plugin id to a direct child directory of `pluginsDir`.
     *
     * Plugin ids cross the renderer/main trust boundary, and this id is about to
     * become a filesystem path — so the confinement rule is identical to
     * `ThemeService.fileFor`: resolve the candidate, then refuse it unless its
     * parent is exactly `pluginsDir`. That rejects `../..`, an absolute path, or
     * any other attempt to name a directory outside the managed tree, BEFORE the
     * path reaches `remove`, `copy` or the shell. Every mutating operation goes
     * through here first.
     */
    /**
     * The path a plugin id WOULD occupy in the installed root, whether or not it
     * exists yet.
     *
     * Split out from `dirFor` because the two questions are genuinely different
     * and conflating them broke install. `dirFor` answers "where does this
     * plugin live?" and therefore must only return a directory that exists;
     * `installFromFolder` asks "where should this plugin GO?" about an id that by
     * definition does not exist yet. Sharing one function meant every install of
     * a new plugin failed with "a plugin id must name a directory directly inside
     * ~/starbase/plugins" — about an id that was perfectly valid.
     *
     * The confinement check is the same one, and is the reason this is a function
     * rather than a `join`: the id reaches `copy` and `remove`, so `../..` and
     * absolute paths have to be refused before it gets there.
     */
    const destFor = (
      pluginId: string
    ): Effect.Effect<string, PluginError, Path.Path | AppPaths> =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const root = path.resolve(yield* pluginsDir)
        const dir = path.resolve(root, pluginId)
        if (path.dirname(dir) !== root) {
          return yield* Effect.fail(
            new PluginError({
              pluginId,
              reason: "A plugin id must name a directory directly inside ~/starbase/plugins."
            })
          )
        }
        return dir
      })

    const dirFor = (
      pluginId: string
    ): Effect.Effect<string, PluginError, Path.Path | AppPaths | FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const bundled = yield* builtinDir

        // Both roots, installed first — the same precedence `list` applies, so
        // an installed override resolves to the copy actually being used.
        //
        // Checking only the installed root meant Reveal on a BUILT-IN plugin
        // resolved to `~/starbase/plugins/<id>`, a path it does not live at, and
        // opened a Finder window on nothing.
        for (const rootPath of [yield* pluginsDir, bundled]) {
          if (!rootPath) continue
          const root = path.resolve(rootPath)
          const dir = path.resolve(root, pluginId)
          // Confinement is unchanged and still applies per root: the id must
          // name a DIRECT child, so `../..` and absolute paths are refused
          // before this reaches `remove`, `copy` or the shell.
          if (path.dirname(dir) !== root) continue
          if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) return dir
        }

        return yield* Effect.fail(
          new PluginError({
            pluginId,
            reason: "A plugin id must name a directory directly inside ~/starbase/plugins."
          })
        )
      })

    /**
     * Every subdirectory of `pluginsDir` whose manifest decoded, plus the ones
     * that did not.
     *
     * Each directory is read and decoded INDEPENDENTLY inside its own `Effect.
     * either`, so a single unreadable file or malformed manifest becomes one
     * entry in `failed` rather than aborting the scan — the invariant the whole
     * "listing never fails" contract rests on.
     *
     * A missing `pluginsDir` is not an error: it is the normal state until the
     * first install, and creating it eagerly on every list would have the app
     * write to disk just for opening a settings tab.
     */
    const readManifests = (): Effect.Effect<
      { decoded: ReadonlyArray<DecodedPlugin>; failed: ReadonlyArray<PluginLoadFailure> },
      never,
      PluginEnv
    > =>
      Effect.gen(function* () {
        const installed = yield* scanRoot(yield* pluginsDir, false)
        const bundled = yield* scanRoot(yield* builtinDir, true)

        // Bundled first, then installed. An installed plugin with the same id as
        // a bundled one WINS — that is how an operator tries a fix or a fork of
        // an official plugin without waiting for a release, and it is the same
        // precedence a user theme has over a vendored one.
        const byId = new Map<string, DecodedPlugin>()
        for (const plugin of [...bundled.decoded, ...installed.decoded]) {
          byId.set(plugin.manifest.id, plugin)
        }

        return {
          decoded: [...byId.values()],
          failed: [...bundled.failed, ...installed.failed]
        }
      })

    /** Read every plugin directory under one root. */
    const scanRoot = (
      root: string | undefined,
      builtin: boolean
    ): Effect.Effect<
      { decoded: ReadonlyArray<DecodedPlugin>; failed: ReadonlyArray<PluginLoadFailure> },
      never,
      PluginEnv
    > =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = root

        if (!dir) return { decoded: [], failed: [] }
        const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return { decoded: [], failed: [] }

        const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
        const decoded: Array<DecodedPlugin> = []
        const failed: Array<PluginLoadFailure> = []

        for (const entry of entries) {
          const pluginDir = path.join(dir, entry)

          // Stray files (a `.DS_Store`, a README) are not failed plugins — they
          // are simply not plugins, so a non-directory is skipped, not reported.
          const info = yield* fs.stat(pluginDir).pipe(Effect.either)
          if (info._tag === "Left" || info.right.type !== "Directory") continue

          const manifestFile = path.join(pluginDir, MANIFEST_FILE)
          const raw = yield* fs.readFileString(manifestFile).pipe(Effect.orElseSucceed(() => null))
          if (raw === null) {
            // In the INSTALLED root the operator put this directory there, so a
            // missing manifest is worth reporting. In the BUNDLED root we put it
            // there — `plugins/examples/` is a container, not a plugin — and
            // reporting it made every dev launch show a permanent "broken
            // plugin" in Settings that the operator can do nothing about.
            //
            // A manifest that EXISTS and fails to decode is still reported from
            // either root: that is a real broken plugin whoever shipped it.
            if (!builtin) {
              failed.push({
                dir: entry,
                kind: "manifest-missing",
                message: `No ${MANIFEST_FILE} in this directory.`
              })
            }
            continue
          }

          const result = yield* Schema.decodeUnknown(Schema.parseJson(PluginManifestSchema))(raw).pipe(Effect.either)
          if (result._tag === "Left") {
            failed.push({ dir: entry, kind: "manifest-invalid", message: describeDecodeFailure(result.left) })
            continue
          }
          const manifest = result.right

          // The manifest can PROMISE an entry file the directory does not hold —
          // a typo in `main`, a `ui` bundle that was never built. That is a
          // load-time failure the operator should see when they install, not a
          // silent no-op the first time they open the plugin's tab.
          const missingEntry = yield* firstMissingEntry(fs, path, pluginDir, manifest)
          if (missingEntry !== null) {
            failed.push({
              dir: entry,
              kind: "entry-missing",
              message: `Declared entry "${missingEntry}" does not exist in the plugin directory.`
            })
            continue
          }

          decoded.push({ dir: pluginDir, manifest, builtin })
        }

        return { decoded, failed }
      })

    /**
     * The whole plugin set, folded to what the UI renders.
     *
     * Three things happen here that `readManifests` cannot: dependencies are
     * resolved into a load order (and unresolvable ones moved to `failed`), the
     * persisted disabled-set decides each plugin's `enabled`, and the result is
     * assembled into a `PluginCatalog`. Never fails — a config that will not read
     * folds to "nothing disabled", which is the safe direction.
     */
    const list = (): Effect.Effect<PluginCatalog, never, PluginEnv> =>
      Effect.gen(function* () {
        const { decoded, failed } = yield* readManifests()
        const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
        const disabled = new Set(config?.disabledPlugins ?? [])

        const { ordered, failed: depFailed } = resolveLoadOrder(decoded)

        const plugins: Array<LoadedPlugin> = ordered.map((entry) => ({
          manifest: entry.manifest,
          dir: entry.dir,
          enabled: !disabled.has(entry.manifest.id),
          // The registry does not run host halves — that is the extension host's
          // job — so from here every plugin is un-activated by definition.
          activated: false,
          builtin: entry.builtin
        }))

        return { plugins, failed: [...failed, ...depFailed] }
      })

    /**
     * Turn a plugin on or off, persisting the choice in `WorkspaceConfig`.
     *
     * A disabled plugin stays in the catalog (so the operator can turn it back
     * on) but contributes nothing and never activates — enforced by the host and
     * the renderer reading `enabled`, which this sets by adding/removing the id
     * from the persisted disabled-set. Runs `dirFor` first purely for its
     * confinement check: a renderer-supplied id that escapes the plugins tree is
     * refused before it can be written into config as a phantom entry.
     */
    const setEnabled = (pluginId: string, enabled: boolean): Effect.Effect<void, PluginError, PluginEnv> =>
      Effect.gen(function* () {
        yield* dirFor(pluginId)
        const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
        const current = new Set(config?.disabledPlugins ?? [])
        if (enabled) current.delete(pluginId)
        else current.add(pluginId)
        yield* ConfigService.setDisabledPlugins([...current]).pipe(
          Effect.mapError(
            (cause) => new PluginError({ pluginId, reason: "Could not persist the enabled/disabled change.", cause })
          )
        )
      })

    /**
     * Delete a plugin's directory. Fails for an id that resolves nowhere.
     *
     * Unlike `ThemeService.remove` (where a missing file is the outcome the
     * caller wanted), an uninstall of a plugin that is not installed is a
     * mistake worth surfacing — the renderer only offers uninstall for plugins
     * it is showing, so a miss means the catalog and disk have drifted.
     */
    const uninstall = (pluginId: string): Effect.Effect<void, PluginError, PluginEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* dirFor(pluginId)

        // `dirFor` resolves BUNDLED plugins too, so Reveal can open one. Delete
        // must not follow it there: in a packaged build that is inside the app,
        // and in development it is the repo's own `plugins/` — one click in
        // Settings would `rm -rf` checked-in source. Settings already hides the
        // control for built-ins; this is the half that cannot be bypassed.
        const installedRoot = path.resolve(yield* pluginsDir)
        if (path.dirname(path.resolve(dir)) !== installedRoot) {
          return yield* Effect.fail(
            new PluginError({
              pluginId,
              reason: "That plugin ships with Starbase and cannot be uninstalled. Disable it instead."
            })
          )
        }
        const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
        if (!exists) {
          return yield* Effect.fail(new PluginError({ pluginId, reason: "That plugin is not installed." }))
        }
        yield* fs
          .remove(dir, { recursive: true })
          .pipe(Effect.mapError((cause) => new PluginError({ pluginId, reason: "Could not remove the plugin directory.", cause })))
      })

    /**
     * Copy a folder into `~/starbase/plugins` and load it.
     *
     * The source is decoded to a valid `PluginManifest` FIRST, so the plugin's
     * own declared id names the destination directory (`pluginsDir/<id>`) and a
     * folder that is not a plugin fails before anything is copied — no partial
     * directory is ever left behind. Refuses to overwrite an existing install:
     * replacing a plugin is uninstall-then-install, not a silent clobber.
     */
    const installFromFolder = (sourcePath: string): Effect.Effect<LoadedPlugin, PluginError, PluginEnv> =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const manifestFile = path.join(sourcePath, MANIFEST_FILE)
        const raw = yield* fs
          .readFileString(manifestFile)
          .pipe(
            Effect.mapError(
              () => new PluginError({ pluginId: sourcePath, reason: `No ${MANIFEST_FILE} in the selected folder.` })
            )
          )
        const manifest = yield* Schema.decodeUnknown(Schema.parseJson(PluginManifestSchema))(raw).pipe(
          Effect.mapError(
            (cause) => new PluginError({ pluginId: sourcePath, reason: `Not a valid plugin: ${describeDecodeFailure(cause)}` })
          )
        )

        // `destFor`, not `dirFor`. `dirFor` only returns a directory that EXISTS,
        // which is right for Reveal and Uninstall and exactly wrong here: the id
        // being installed does not exist yet by definition, so every install of a
        // new plugin failed with "a plugin id must name a directory directly
        // inside ~/starbase/plugins" about an id that was perfectly valid.
        //
        // It also has to be the INSTALLED root specifically. `dirFor` resolves
        // bundled plugins too, so installing a fork of an official plugin would
        // have found the bundled copy and refused as "already installed" —
        // defeating the documented promise that an installed override wins.
        const dest = yield* destFor(manifest.id)
        const exists = yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))
        if (exists) {
          return yield* Effect.fail(
            new PluginError({ pluginId: manifest.id, reason: `"${manifest.id}" is already installed. Uninstall it first.` })
          )
        }

        const root = yield* pluginsDir
        yield* fs
          .makeDirectory(root, { recursive: true })
          .pipe(Effect.mapError((cause) => new PluginError({ pluginId: manifest.id, reason: "Could not create ~/starbase/plugins.", cause })))
        yield* fs
          .copy(sourcePath, dest)
          .pipe(Effect.mapError((cause) => new PluginError({ pluginId: manifest.id, reason: "Could not copy the plugin into place.", cause })))

        return { manifest, dir: dest, enabled: true, activated: false, builtin: false }
      })

    /**
     * Re-emit the whole catalog whenever `~/starbase/plugins` changes on disk.
     *
     * The whole catalog rather than a per-directory delta, for the same reason
     * `ThemeService.watch` does: the consumer is a settings list that renders the
     * full set, which would have to rebuild that set from deltas anyway and would
     * drift the first time an event was dropped.
     *
     * **Consume with `Stream.unwrap(Effect.map(PluginRegistry, (p) =>
     * p.watch()))`, never the generated accessor.** An `Effect` is itself a
     * one-element `Stream`, so `PluginRegistry.watch()` type-checks where a
     * `Stream<PluginCatalog>` is wanted and silently yields a stream whose single
     * element is the real stream — no error, and the catalog never arrives.
     * `Theme.watch` in `main/rpc.ts` has this exact shape.
     */
    const watch = (): Stream.Stream<PluginCatalog, never, PluginEnv> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const installed = yield* pluginsDir
          const bundled = yield* builtinDir

          // Watch a directory that exists — creating it first also means the very
          // first install shows up live rather than needing a relaunch.
          yield* fs
            .makeDirectory(installed, { recursive: true })
            .pipe(Effect.orElseSucceed(() => undefined))

          // BOTH roots. `app-paths.ts` sells the dev bundled root as "the same
          // live-reload story a third-party author gets", and watching only the
          // installed root made that untrue: an official plugin under active
          // edit needed a relaunch. Not created if absent — a packaged build
          // with no bundled plugins should not have a directory conjured for it.
          const bundledExists =
            bundled !== undefined &&
            bundled !== installed &&
            (yield* fs.exists(bundled).pipe(Effect.orElseSucceed(() => false)))

          // RECURSIVE, and that is the whole of live reload.
          //
          // `fs.watch` reports only DIRECT children by default. The direct
          // children of `~/starbase/plugins` are the plugin directories
          // themselves, so a non-recursive watch fires when a plugin is installed
          // or removed and never when one is EDITED: the files an author actually
          // rewrites — `starbase.plugin.json` and `dist/ui.js` — are one level
          // down.
          //
          // The effect was that "Starbase watches ~/starbase/plugins and reloads
          // without a restart" was true only for adding and deleting folders, and
          // the advice to bump `version` to defeat the ES-module URL cache could
          // not work, because nothing ever re-read the manifest to notice the new
          // version. Every author's inner loop was silently a relaunch.
          //
          // Supported on every platform on Node 20+, and this repo requires 22.
          //
          // Recursive does mean the DEVELOPMENT bundled root — the repo's own
          // `plugins/`, `node_modules` and all — produces events during a plugin
          // build. That is noisy rather than harmful: an emission costs one
          // catalog re-read, and the renderer keys its module cache on
          // `id@version`, so nothing re-imports or remounts unless a version
          // actually changed.
          const options = { recursive: true } as const
          const sources = [
            fs.watch(installed, options),
            ...(bundledExists && bundled ? [fs.watch(bundled, options)] : [])
          ]

          return Stream.mergeAll(sources, { concurrency: sources.length }).pipe(
            Stream.debounce(WATCH_DEBOUNCE_MS),
            Stream.mapEffect(() => list()),
            // A dead watcher takes live reload with it; ending the stream leaves
            // the app fully usable, just without external-edit pickup until the
            // next launch — the same trade `ThemeService.watch` makes.
            Stream.catchAll(() => Stream.empty)
          )
        })
      )

    return { list, watch, dirFor, setEnabled, uninstall, installFromFolder }
  }
}) {}

/**
 * Which declared entry file, if any, is missing from a plugin directory.
 *
 * `ui` and `main` are paths relative to the plugin directory; a manifest may
 * declare either, both or neither. Returns the first one that does not resolve
 * to a real file, or null when every declared entry is present.
 */
const firstMissingEntry = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  pluginDir: string,
  manifest: PluginManifest
): Effect.Effect<string | null, never, never> =>
  Effect.gen(function* () {
    for (const entry of [manifest.ui, manifest.main]) {
      if (!entry) continue
      const exists = yield* fs.exists(path.join(pluginDir, entry)).pipe(Effect.orElseSucceed(() => false))
      if (!exists) return entry
    }
    return null
  })

/**
 * Order plugins so every dependency loads before its dependents, moving the ones
 * that cannot be ordered into `failed`.
 *
 * A depth-first walk with an on-stack marker. Three outcomes per plugin:
 * - it needs a plugin that is not installed → `dependency-missing`;
 * - it sits on a cycle (a back edge reaches a plugin still on the stack), or it
 *   depends on one that does → `dependency-cycle`;
 * - it and all its dependencies resolve → appended to `ordered` AFTER them.
 *
 * The on-stack marker is what makes a cycle terminate instead of hang: the
 * second time the walk reaches a plugin it is already visiting, it reports the
 * cycle and unwinds rather than recursing forever. Every node's frame runs once
 * (memoised), so the walk is linear no matter how tangled the graph.
 */
const resolveLoadOrder = (
  entries: ReadonlyArray<DecodedPlugin>
): { ordered: ReadonlyArray<DecodedPlugin>; failed: ReadonlyArray<PluginLoadFailure> } => {
  const byId = new Map(entries.map((e) => [e.manifest.id, e] as const))
  const ordered: Array<DecodedPlugin> = []
  const failed: Array<PluginLoadFailure> = []

  type Outcome = "ok" | "missing" | "cycle"
  const settled = new Map<string, Outcome>()
  const onStack = new Set<string>()

  const recordFailure = (entry: DecodedPlugin, kind: PluginFailureKind, message: string): void => {
    failed.push({ dir: basename(entry.dir), kind, message })
  }

  const visit = (entry: DecodedPlugin): Outcome => {
    const id = entry.manifest.id
    const memo = settled.get(id)
    if (memo) return memo
    // A back edge onto a plugin still being visited IS the cycle. Return without
    // memoising — this frame is still open and will settle when it unwinds.
    if (onStack.has(id)) return "cycle"

    onStack.add(id)
    let outcome: Outcome = "ok"
    for (const depId of entry.manifest.extensionDependencies ?? []) {
      const dep = byId.get(depId)
      if (!dep) {
        outcome = "missing"
        recordFailure(entry, "dependency-missing", `requires "${depId}", which is not installed.`)
        break
      }
      const depOutcome = visit(dep)
      if (depOutcome === "cycle") {
        outcome = "cycle"
        recordFailure(entry, "dependency-cycle", `is part of a dependency cycle through "${depId}".`)
        break
      }
      if (depOutcome === "missing") {
        outcome = "missing"
        recordFailure(entry, "dependency-missing", `depends on "${depId}", which failed to load.`)
        break
      }
    }
    onStack.delete(id)
    settled.set(id, outcome)
    // Pushed only on success, and only after every dependency — so `ordered` is
    // a valid load order by construction.
    if (outcome === "ok") ordered.push(entry)
    return outcome
  }

  for (const entry of entries) visit(entry)
  return { ordered, failed }
}

/** The last path segment — the plugin's directory NAME, which is what `PluginLoadFailure.dir` carries. */
const basename = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir

/**
 * Turn a `ParseError` into something an operator can act on — the same problem,
 * and the same solution, as `ThemeService`'s decoder.
 *
 * Effect's default message leads with the full expected-schema signature, which
 * for `PluginManifest` is a long type expression that is identical for every
 * failure. `ArrayFormatter` instead yields one entry per issue with a structured
 * path, which is the part worth showing; capped at three because a wholly wrong
 * file produces dozens and a wall of them is as unactionable as none.
 */
const describeDecodeFailure = (cause: unknown): string => {
  if (ParseResult.isParseError(cause)) {
    const issues = ArrayFormatter.formatErrorSync(cause)
    const described = issues.slice(0, 3).map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "the manifest"
      return `${where}: ${issue.message}`
    })
    if (described.length > 0) {
      const more = issues.length > described.length ? ` (+${issues.length - described.length} more)` : ""
      return `${described.join("; ")}${more}`.slice(0, 240)
    }
  }
  const text = cause instanceof Error ? cause.message : String(cause)
  return (text.split("\n").find((line) => line.trim().length > 0) ?? "unrecognised shape").trim().slice(0, 240)
}

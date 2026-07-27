import { Context } from "effect"

/**
 * Resolved filesystem locations Jingler owns, all under `~/jingler`. The Live
 * layer is provided by the Electron main process (which resolves the real home
 * directory); keeping this a `Context.Tag` lets `cli-adapters` stay
 * environment-agnostic and unit-testable with a fake path root.
 */
export interface AppPathsShape {
  /** The managed root directory, `~/jingler`. */
  readonly root: string
  /** `~/jingler/config.json` — persisted `WorkspaceConfig`. */
  readonly configFile: string
  /** `~/jingler/sessions.json` — persisted session list. */
  readonly sessionsFile: string
  /** `~/jingler/worktrees` — parent of every session's isolated worktree. */
  readonly worktreesDir: string
  /** `~/jingler/transcripts` — parent of every session's persisted transcript. */
  readonly transcriptsDir: string
  /**
   * `~/jingler/reviews` — the last adversarial review per session, at
   * `<reviewsDir>/<sessionId>.json`. Kept out of `sessions.json` on purpose: a
   * review carries an unbounded findings array, and bloating the session list
   * would slow every sidebar read.
   */
  readonly reviewsDir: string
  /**
   * `~/jingler/.jingler` — the plan library. Each session's plans live under
   * `<plansDir>/<worktree-slug>/<plan-name>.md`, so a plan can be picked back up
   * (read from disk) in a later turn or session on the same worktree.
   */
  readonly plansDir: string
  /**
   * `~/jingler/plan-rounds` — the last adversarial planning round per session,
   * at `<planRoundsDir>/<sessionId>.json`.
   *
   * Separate from `plansDir` (which holds plan markdown keyed by worktree)
   * because this is the audit trail rather than the artefact: it keeps the
   * pre-revision proposal and the critique, so "did the critic actually attack,
   * and did the proposer engage or cave?" stays answerable after the fact. Kept
   * out of the transcript for the same reason reviews are — a critique carries
   * an unbounded challenge list.
   */
  readonly planRoundsDir: string
  /**
   * `~/jingler/themes` — user-authored colour themes, one VS Code theme JSON
   * per file at `<themesDir>/<id>.json`.
   *
   * A directory of plain files rather than a section of `config.json` for two
   * reasons. A theme is kilobytes of colour table and `config.json` is
   * read-modify-written on every settings save, so inlining them would make an
   * unrelated toggle rewrite every theme the user owns. And themes are a format
   * people already exchange — being able to drop a file in, or hand one to
   * someone, is most of the point of storing VS Code's format at all.
   */
  readonly themesDir: string
  /**
   * `~/jingler/plugins` — installed plugins, one directory per plugin, each
   * holding a `jingler.plugin.json`. A directory of folders rather than a
   * section of `config.json` for the same reason themes are files: a plugin is a
   * bundle (manifest plus UI/host entry files), people already exchange them, and
   * `config.json` is read-modify-written on every settings save — inlining plugin
   * code there would rewrite it on every unrelated toggle.
   */
  readonly pluginsDir: string
  /**
   * Plugins that ship inside the app, read-only.
   *
   * Undefined when nothing is bundled — a dev run before the plugins are built,
   * or a test with a synthetic AppPaths. Absent means "no built-ins", never an
   * error, so the registry works identically either way.
   */
  readonly builtinPluginsDir?: string
  /**
   * `~/jingler/plugin-storage` — each plugin's private key/value store, one JSON
   * file per plugin at `<pluginStorageDir>/<pluginId>.json`.
   *
   * A sibling of `pluginsDir`, never inside it, so a plugin's persisted state
   * outlives a reinstall of its code (uninstall removes the plugin directory; the
   * store is only cleared on an explicit request) and so scanning `pluginsDir`
   * for manifests never trips over a plugin's data files.
   */
  readonly pluginStorageDir: string
  /**
   * `~/jingler/auth.enc` — the signed-in session token, encrypted with the OS
   * credential vault (Electron `safeStorage`). Only ever ciphertext is written
   * here; see `SecretStore`.
   */
  readonly authFile: string
  /**
   * `~/jingler/open-connector.enc` — the self-hosted OpenConnector instance's
   * bearer token, encrypted with the OS credential vault. A sibling of `authFile`
   * (never the same file) so the MCP token and the sign-in token are independent:
   * signing out must not drop the instance credential. Only ciphertext is written.
   */
  readonly openConnectorFile: string
}

export class AppPaths extends Context.Tag("@jingler/AppPaths")<AppPaths, AppPathsShape>() {}

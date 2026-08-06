import { Data, Schema } from "effect"
import { PlanDocument } from "./plan-document.js"

/**
 * Raised when a known CLI binary cannot be resolved on the host.
 * Not fatal to a discovery scan — it is folded into an unavailable `CliInfo`.
 */
export class CliNotFoundError extends Data.TaggedError("CliNotFoundError")<{
  readonly kind: string
  readonly message: string
}> {}

/** Raised when invoking a CLI process fails (spawn error, non-zero exit, etc.). */
export class CliExecError extends Data.TaggedError("CliExecError")<{
  readonly kind: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Raised when the overall discovery scan cannot run (e.g. no command executor).
 * A `Schema.TaggedError` (not `Data.TaggedError`) because it crosses the RPC
 * boundary as the `Discovery.list` error — RPC error channels must be schemas.
 */
export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()(
  "DiscoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a requested session cannot be found in the store. A
 * `Schema.TaggedError` because it is the `Sessions.get` RPC error channel.
 */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionId: Schema.String
  }
) {}

/**
 * Raised when an operation needs a configured repos directory but the user has
 * not completed first-run setup yet. A `Schema.TaggedError` — it is the
 * `Workspace.repos` RPC error channel.
 */
export class WorkspaceNotConfiguredError extends Schema.TaggedError<WorkspaceNotConfiguredError>()(
  "WorkspaceNotConfiguredError",
  {}
) {}

/**
 * Raised when reading or writing the persisted config/sessions files fails.
 * A `Schema.TaggedError` so it can cross the RPC boundary.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a call to the self-hosted OpenConnector instance fails — not
 * configured (no endpoint/token), unreachable, or a non-OK response. A
 * `Schema.TaggedError` because it is the error channel for the `Connector.*` RPCs
 * that back the MCP Connector Center.
 */
export class ConnectorError extends Schema.TaggedError<ConnectorError>()(
  "ConnectorError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a git operation (branch lookup, `worktree add`, repo scan) fails.
 * A `Schema.TaggedError` — it is the error channel for the worktree/branch RPCs.
 */
export class GitError extends Schema.TaggedError<GitError>()(
  "GitError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a `gh` (GitHub CLI) write fails — `gh pr create`, `gh pr comment`,
 * `gh pr review`. A `Schema.TaggedError` so it can cross the RPC boundary as the
 * error channel for the `Github.*` write RPCs. Reads never fail (fold to null).
 */
export class GhError extends Schema.TaggedError<GhError>()(
  "GhError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when an adversarial review cannot run — no linked PR, no worktree, an
 * unresolvable PR head, or the reviewer harness failing to start. A
 * `Schema.TaggedError` so it crosses the RPC boundary as the `Review.run` error
 * channel.
 *
 * Note what is NOT an error here: a reviewer that runs but emits unparseable
 * output (a refusal, prose instead of JSON) succeeds with `note` set and no
 * findings. Only a review that could not *happen* fails.
 */
export class ReviewError extends Schema.TaggedError<ReviewError>()(
  "ReviewError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/** A proposed MDX document failed the safe PRD contract. */
export class PlanValidationError extends Schema.TaggedError<PlanValidationError>()(
  "PlanValidationError",
  {
    message: Schema.String,
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        line: Schema.Number
      })
    )
  }
) {}

/** The canonical plan could not be durably read or written. */
export class PlanPersistenceError extends Schema.TaggedError<PlanPersistenceError>()(
  "PlanPersistenceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/** A compare-and-swap plan write targeted an obsolete canonical revision. */
export class PlanConflictError extends Schema.TaggedError<PlanConflictError>()(
  "PlanConflictError",
  {
    message: Schema.String,
    latestRevision: Schema.Number,
    latest: Schema.NullOr(PlanDocument)
  }
) {}

/**
 * Raised when a PTY-backed terminal cannot be spawned (bad cwd, shell missing,
 * fork failure). A `Schema.TaggedError` — it is the `Terminal.create` error
 * channel. Write/resize/kill/attach never fail (they no-op on an unknown id).
 */
export class TerminalError extends Schema.TaggedError<TerminalError>()(
  "TerminalError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when the embedded browser preview can't act on a request — most
 * commonly a non-http(s) URL (the pane only loads localhost dev servers). A
 * `Schema.TaggedError` so it encodes across the RPC boundary; it is the error
 * channel for `BrowserPreview.open` / `BrowserPreview.navigate`.
 */
export class BrowserPreviewError extends Schema.TaggedError<BrowserPreviewError>()(
  "BrowserPreviewError",
  {
    message: Schema.String
  }
) {}

/**
 * Raised when the embedded browser can't act on an AGENT QA request — a
 * selector that matched nothing, a script that threw, a wait that timed out, or
 * a non-http(s) navigation. `op` names the failing operation ("click",
 * "screenshot", …) so the agent gets a specific reason back. A
 * `Schema.TaggedError` so it encodes across the RPC boundary; the error channel
 * for every `BrowserControl.*` procedure.
 */
export class BrowserControlError extends Schema.TaggedError<BrowserControlError>()(
  "BrowserControlError",
  {
    op: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Raised when a theme cannot be read, written or deleted — a malformed JSON
 * file in `~/jingler/themes`, a write to a built-in id, or an import whose
 * shape isn't a VS Code theme.
 *
 * Carries `themeId` alongside the message because the operator is almost always
 * looking at a grid of nine-plus swatches when this fires, and "failed to save
 * theme" without naming which one is an error message that costs more time than
 * it saves.
 *
 * Note that LISTING never uses this channel: one broken file must not empty the
 * picker, so `ThemeCatalog.skipped` reports per-file failures inline instead.
 */
export class ThemeError extends Schema.TaggedError<ThemeError>()(
  "ThemeError",
  {
    message: Schema.String,
    themeId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.String)
  }
) {}

/**
 * Raised when a requested asset path resolves OUTSIDE the session's worktree.
 *
 * This is the feature's security boundary, not a user-error message. The paths
 * that reach `Asset.read` come from agent output — a transcript is untrusted
 * input that happens to name files — so `../../../.ssh/id_rsa`, an absolute
 * path, and a symlink pointing at `/etc/passwd` all land here. Main resolves
 * the realpath and compares against the worktree root; the renderer is never
 * trusted to have done that.
 *
 * Deliberately carries only the requested path, never the resolved one:
 * echoing where a traversal *landed* is a filesystem oracle.
 */
export class AssetOutsideWorktreeError extends Schema.TaggedError<AssetOutsideWorktreeError>()(
  "AssetOutsideWorktreeError",
  {
    /** The path as requested — worktree-relative, or whatever was asked for. */
    path: Schema.String,
    /** Why it was refused: no worktree, escaped the root, or not a regular file. */
    reason: Schema.Literal("no-worktree", "escapes-root", "not-a-file", "unreadable")
  }
) {}

/**
 * Raised when an asset is over its per-kind size cap (`ASSET_SIZE_CAP`).
 *
 * A distinct error rather than a truncated read, because silently showing the
 * first 5 MB of a 400 MB CSV is the kind of thing an operator acts on without
 * noticing. Carries both numbers so the viewer can say "42 MB, cap is 5 MB"
 * and offer Reveal in Finder instead.
 */
export class AssetTooLargeError extends Schema.TaggedError<AssetTooLargeError>()(
  "AssetTooLargeError",
  {
    path: Schema.String,
    /** Actual size in bytes. */
    size: Schema.Number,
    /** The cap that was exceeded, in bytes. */
    cap: Schema.Number
  }
) {}

/**
 * Raised when a path has no viewer — an extension outside `extensionToKind`'s
 * allow-list.
 *
 * In normal use the renderer never asks (it gates clickability on the same
 * pure function), so this fires only when the two get out of step — a stale
 * persisted dock tab, mainly. Worth a typed error rather than a crash.
 */
export class AssetUnsupportedError extends Schema.TaggedError<AssetUnsupportedError>()(
  "AssetUnsupportedError",
  {
    path: Schema.String
  }
) {}

/** Raised when an existing asset is not valid editable UTF-8 text. */
export class AssetBinaryError extends Schema.TaggedError<AssetBinaryError>()(
  "AssetBinaryError",
  {
    path: Schema.String
  }
) {}

/** Raised when an asset changed after the renderer loaded its revision. */
export class AssetWriteConflictError extends Schema.TaggedError<AssetWriteConflictError>()(
  "AssetWriteConflictError",
  {
    path: Schema.String,
    expectedRevision: Schema.String,
    actualRevision: Schema.String
  }
) {}

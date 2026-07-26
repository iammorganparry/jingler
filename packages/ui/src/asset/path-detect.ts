import { extensionToKind } from "@starbase/core"

/**
 * Deciding whether a scrap of agent output is a file worth opening.
 *
 * The hard part is not finding paths — it is NOT finding things that merely look
 * like them. A transcript is full of `v1.2.3`, `npm.install`, `package.json` (in
 * a sentence about a file that isn't in this repo) and `foo.bar()`. Turn those
 * into links and every third word in the transcript becomes a dead affordance,
 * which is worse than no links at all.
 *
 * So there are three gates, cheapest first, and the third is the one that
 * actually works: the candidate must be a file that really exists in this
 * session's worktree. That list is already fetched for the composer's `@` menu
 * (`Workspace.files`), so the check costs nothing.
 */

/**
 * A path-shaped token: segments of word characters, dots, dashes and @, joined
 * by `/`, ending in a 1–5 character extension, with an optional `:line` suffix.
 *
 * Anchored at both ends so it matches the WHOLE token — a sentence containing a
 * path is not itself a path.
 */
const PATH_SHAPE = /^\/?[\w.@-]+(?:\/[\w.@ -]+)*\.[a-z0-9]{1,5}(?::\d+(?::\d+)?)?$/i

/** Anything with a URL scheme is somebody else's business — a link, not a file. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** Strip a trailing `:12` / `:12:5` line-column suffix agents append to paths. */
const stripLineSuffix = (path: string): string => path.replace(/:\d+(?::\d+)?$/, "")

/**
 * Normalize a candidate to the form `knownFiles` uses, or null if it can't be
 * one. Exported for tests.
 */
export const normalizeCandidate = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || HAS_SCHEME.test(trimmed)) return null
  // `./docs/spec.md` and `docs/spec.md` are the same file; git lists the latter.
  const withoutDot = trimmed.replace(/^\.\//, "")
  return withoutDot.length === 0 ? null : withoutDot
}

/**
 * The path to open for this candidate, or null if it isn't one.
 *
 * Always returns a WORKTREE-RELATIVE path, even when the input was absolute.
 * That is not cosmetic. `Asset.read` resolves what it is given against the
 * session's worktree, and `resolve(root, "/docs/spec.md")` discards the root
 * entirely — so handing back a root-relative href (which is exactly what
 * markdown gives us: `./docs/spec.md` arrives here as `/docs/spec.md`) would
 * point the read at `/docs/spec.md` on the real filesystem and get it correctly
 * refused as outside the worktree. Returning the matched entry sidesteps that
 * for every input shape at once.
 */
export const resolveOpenablePath = (
  raw: string,
  knownFiles: ReadonlySet<string>
): string | null => {
  const candidate = normalizeCandidate(raw)
  if (candidate === null) return null

  const path = stripLineSuffix(candidate)
  if (!PATH_SHAPE.test(candidate)) return null
  // Gate two: we must have a viewer. `extensionToKind` is the same closed
  // allow-list main reads, so a link can never open onto "unsupported".
  if (extensionToKind(path) === null) return null

  // Gate three. An exact hit is the common case (agents write worktree-relative
  // paths); an absolute path is matched by suffix on a SEGMENT boundary, so
  // `/w/src/app.ts` finds `src/app.ts` but `/w/notapp.ts` never matches `app.ts`.
  if (knownFiles.has(path)) return path
  if (path.startsWith("/")) {
    for (const file of knownFiles) {
      if (path.endsWith(`/${file}`)) return file
    }
  }
  return null
}

/** Whether `raw` should render as a link into the Preview dock. */
export const isOpenablePath = (raw: string, knownFiles: ReadonlySet<string>): boolean =>
  resolveOpenablePath(raw, knownFiles) !== null

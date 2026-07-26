/**
 * Reads the files an agent leaves behind in a session's worktree, for the
 * Preview dock.
 *
 * ## This is a security boundary, not a convenience wrapper
 *
 * Every path that reaches this service came out of agent output. A transcript
 * is untrusted input that happens to name files, so `../../../.ssh/id_rsa`, a
 * bare absolute path, and a symlink whose target is `/etc/passwd` are all
 * expected inputs — not edge cases. The containment check in `resolveInside`
 * is the only thing standing between a rendered markdown link and reading an
 * arbitrary file off the operator's disk, which is why it resolves the REAL
 * path before comparing and why it lives here in main rather than in the
 * renderer, where a compromised transcript could route around it.
 *
 * ## Why `stat` before read, always
 *
 * Text crosses the RPC boundary JSON-encoded and images cross it base64'd — a
 * 4/3 blow-up the renderer then holds in a `data:` URL. Reading first and
 * checking the size after is the same as not checking: the memory is already
 * spent by then. `ASSET_SIZE_CAP` is consulted against `stat` output, and
 * anything over it fails with `AssetTooLargeError` so the viewer can offer
 * Reveal in Finder instead of trying.
 *
 * ## PDFs deliberately ship no bytes
 *
 * `read` returns metadata only for `kind: "pdf"`. Chromium's own PDF viewer
 * loads the file off disk in a `WebContentsView`; base64-ing 40 MB across IPC
 * so the renderer can throw it away would be the entire cost of the feature
 * for none of its benefit.
 */
import { FileSystem, Path } from "@effect/platform"
import type { AssetKind, AssetPayload, AssetStat } from "@starbase/core"
import {
  ASSET_SIZE_CAP,
  AssetOutsideWorktreeError,
  AssetTooLargeError,
  AssetUnsupportedError,
  extensionToKind,
  extensionToLanguage
} from "@starbase/core"
import { Effect } from "effect"

type AssetEnv = FileSystem.FileSystem | Path.Path

/**
 * Extension → media type for the `data:` URL an image viewer builds.
 *
 * Only the extensions `extensionToKind` classifies as `image` need an entry;
 * anything missing falls back to `application/octet-stream`, which renders as a
 * broken image rather than as a wrong one.
 */
const MEDIA_TYPE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml"
}

const mediaTypeFor = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return MEDIA_TYPE[ext] ?? "application/octet-stream"
}

export class AssetService extends Effect.Service<AssetService>()("AssetService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path_ = yield* Path.Path

    /**
     * Resolve `requested` inside `worktree`, or refuse.
     *
     * The order matters. `path_.resolve` collapses `..` textually, which alone
     * would still let a symlink INSIDE the worktree point anywhere on disk —
     * the resolved string looks contained because the escape happens in the
     * filesystem, not in the path. So both sides are put through `realPath`
     * and only then compared, and the comparison requires a separator after
     * the root so that a sibling directory named `worktree-evil` cannot pass
     * a naive `startsWith(root)`.
     */
    const resolveInside = (worktree: string, requested: string) =>
      Effect.gen(function* () {
        const root = yield* fs.realPath(worktree).pipe(
          Effect.mapError(() => new AssetOutsideWorktreeError({ path: requested, reason: "no-worktree" }))
        )
        const target = yield* fs.realPath(path_.resolve(root, requested)).pipe(
          // A missing file and a traversal are the same answer on purpose: the
          // caller learns "no" without learning whether the path exists, so
          // this can't be used to probe the filesystem.
          Effect.mapError(() => new AssetOutsideWorktreeError({ path: requested, reason: "unreadable" }))
        )
        const contained = target === root || target.startsWith(`${root}${path_.sep}`)
        if (!contained) {
          return yield* new AssetOutsideWorktreeError({ path: requested, reason: "escapes-root" })
        }
        return { root, absolutePath: target } as const
      })

    /** The worktree-relative form of an absolute path, in POSIX separators. */
    const relativeTo = (root: string, absolutePath: string): string =>
      path_.relative(root, absolutePath).split(path_.sep).join("/")

    /**
     * Kind + size without contents. Returns `null` for "nothing viewable here"
     * — a miss is the common case when a transcript scans candidate paths, and
     * an error channel would make every non-path inline code span look like a
     * failure.
     */
    const stat = (
      worktree: string,
      requested: string
    ): Effect.Effect<AssetStat | null, never, AssetEnv> =>
      Effect.gen(function* () {
        const kind = extensionToKind(requested)
        if (kind === null) return null
        const resolved = yield* resolveInside(worktree, requested).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
        if (resolved === null) return null
        const info = yield* fs.stat(resolved.absolutePath).pipe(Effect.orElseSucceed(() => null))
        if (info === null || info.type !== "File") return null
        const size = Number(info.size)
        return {
          path: relativeTo(resolved.root, resolved.absolutePath),
          absolutePath: resolved.absolutePath,
          kind,
          size,
          viewable: size <= ASSET_SIZE_CAP[kind]
        }
      })

    const read = (
      worktree: string,
      requested: string
    ): Effect.Effect<
      AssetPayload,
      AssetOutsideWorktreeError | AssetTooLargeError | AssetUnsupportedError,
      AssetEnv
    > =>
      Effect.gen(function* () {
        const kind: AssetKind | null = extensionToKind(requested)
        if (kind === null) return yield* new AssetUnsupportedError({ path: requested })

        const { root, absolutePath } = yield* resolveInside(worktree, requested)

        const info = yield* fs.stat(absolutePath).pipe(
          Effect.mapError(() => new AssetOutsideWorktreeError({ path: requested, reason: "unreadable" }))
        )
        // A directory named `report.pdf` is not an asset. Without this the read
        // below fails with a raw EISDIR that the viewer can't say anything
        // useful about.
        if (info.type !== "File") {
          return yield* new AssetOutsideWorktreeError({ path: requested, reason: "not-a-file" })
        }

        const size = Number(info.size)
        const cap = ASSET_SIZE_CAP[kind]
        if (size > cap) return yield* new AssetTooLargeError({ path: requested, size, cap })

        const base = { path: relativeTo(root, absolutePath), absolutePath, size } as const

        if (kind === "pdf") return { ...base, kind: "pdf" } as const

        if (kind === "image") {
          const bytes = yield* fs.readFile(absolutePath).pipe(
            Effect.mapError(() => new AssetOutsideWorktreeError({ path: requested, reason: "unreadable" }))
          )
          return {
            ...base,
            kind: "image",
            mediaType: mediaTypeFor(absolutePath),
            base64: Buffer.from(bytes).toString("base64")
          } as const
        }

        const text = yield* fs.readFileString(absolutePath, "utf8").pipe(
          Effect.mapError(() => new AssetOutsideWorktreeError({ path: requested, reason: "unreadable" }))
        )
        return {
          ...base,
          kind,
          language: kind === "code" ? extensionToLanguage(absolutePath) : null,
          text
        } as const
      })

    /**
     * The absolute path to hand to the OS file manager, having proved it is
     * inside the worktree. The service does not call `shell` itself — that is
     * Electron, and this package is deliberately free of it.
     */
    const revealPath = (worktree: string, requested: string) =>
      Effect.map(resolveInside(worktree, requested), (r) => r.absolutePath)

    return { read, stat, revealPath } as const
  })
}) {}

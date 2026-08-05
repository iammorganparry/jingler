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
 * ## The residual TOCTOU race, stated rather than hidden
 *
 * `resolveInside` realpaths and compares; `stat` and the read then run on the
 * resolved STRING a moment later. An agent process running continuously in the
 * worktree could, in principle, swap a directory component for a symlink in
 * that window and land the read outside the sandbox. The size cap has the same
 * shape — a file can grow between `stat` and `readFile`.
 *
 * This is knowingly not closed, and the reason is that closing it properly
 * needs an fd-based read (open with `O_NOFOLLOW` per component, `fstat` the
 * descriptor, then read *through* it), which `@effect/platform`'s `FileSystem`
 * does not expose — so a real fix means dropping to `node:fs` and hand-rolling
 * the path walk. Against that: the attacker must win a millisecond-wide race
 * AND have the operator click that exact path at that exact moment, to reach a
 * file the same agent can already read directly with its own tools. The trade
 * is documented here so the next reader knows it was weighed, not missed.
 *
 * ## PDFs deliberately ship no bytes
 *
 * `read` returns metadata only for `kind: "pdf"`. Chromium's own PDF viewer
 * loads the file off disk in a `WebContentsView`; base64-ing 40 MB across IPC
 * so the renderer can throw it away would be the entire cost of the feature
 * for none of its benefit.
 */
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import type { AssetFileEntry, AssetFileStatus, AssetKind, AssetPayload } from "@jingler/core"
import {
  ASSET_SIZE_CAP,
  AssetOutsideWorktreeError,
  AssetTooLargeError,
  AssetUnsupportedError,
  GitError,
  extensionToKind,
  extensionToLanguage
} from "@jingler/core"
import { Effect } from "effect"
import { runGitRaw } from "./command.js"

// Platform services are captured when the service layer is built. Individual
// operations therefore have no invocation-time environment requirements.
type AssetEnv = never
type AssetListEnv = never

const nulPaths = (output: string): string[] =>
  output.split("\0").filter((path) => path.length > 0)

const statusFromCode = (code: string): AssetFileStatus => {
  if (code === "??") return "untracked"
  if (code.includes("R")) return "renamed"
  if (code.includes("A")) return "added"
  if (code.includes("D")) return "deleted"
  return "modified"
}

/** Parse porcelain-v1 `-z`; rename/copy records carry a second old-path field. */
const parseGitStatus = (output: string): ReadonlyMap<string, AssetFileStatus> => {
  const fields = nulPaths(output)
  const status = new Map<string, AssetFileStatus>()
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field.length < 4 || field[2] !== " ") continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    status.set(path, statusFromCode(code))
    if (code.includes("R") || code.includes("C")) index += 1
  }
  return status
}

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
    const commandExecutor = yield* CommandExecutor.CommandExecutor
    const gitRaw = (cwd: string, args: ReadonlyArray<string>) =>
      runGitRaw(cwd, args).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, commandExecutor)
      )
    let listCache: {
      readonly root: string
      readonly fingerprint: string
      readonly entries: ReadonlyArray<AssetFileEntry>
    } | null = null

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
     * Repository browser input: Git decides which paths exist for browsing, then
     * the same realpath + regular-file checks as `read` decide which may cross
     * the process boundary. A tracked symlink escaping the worktree is omitted.
     */
    const list = (
      worktree: string
    ): Effect.Effect<
      ReadonlyArray<AssetFileEntry>,
      AssetOutsideWorktreeError | GitError,
      AssetListEnv
    > =>
      Effect.gen(function* () {
        const { root } = yield* resolveInside(worktree, ".")
        const output = yield* Effect.all(
          {
            tracked: gitRaw(root, ["ls-files", "-z", "--cached"]),
            untracked: gitRaw(root, [
              "ls-files",
              "-z",
              "--others",
              "--exclude-standard"
            ]),
            status: gitRaw(root, [
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all"
            ])
          },
          { concurrency: 3 }
        )
        const fingerprint = `${output.tracked}\u0001${output.untracked}\u0001${output.status}`
        if (listCache?.root === root && listCache.fingerprint === fingerprint) {
          return listCache.entries
        }
        const statusByPath = parseGitStatus(output.status)
        const requestedPaths = [...nulPaths(output.tracked), ...nulPaths(output.untracked)]
        const validated = yield* Effect.forEach(
          requestedPaths,
          (requested) =>
            Effect.gen(function* () {
              if (requested === ".git" || requested.startsWith(".git/")) return null
              const resolved = yield* resolveInside(root, requested).pipe(Effect.option)
              if (resolved._tag === "None") return null
              const info = yield* fs.stat(resolved.value.absolutePath).pipe(Effect.option)
              if (info._tag === "None" || info.value.type !== "File") return null
              const path = relativeTo(root, resolved.value.absolutePath)
              if (path.length === 0 || path === ".git" || path.startsWith(".git/")) return null
              return {
                path,
                status: statusByPath.get(requested) ?? "clean"
              } satisfies AssetFileEntry
            }),
          { concurrency: 32 }
        )
        const byPath = new Map<string, AssetFileEntry>()
        for (const entry of validated) {
          if (entry !== null) byPath.set(entry.path, entry)
        }
        const entries = [...byPath.values()].sort((left, right) =>
          left.path.localeCompare(right.path)
        )
        listCache = { root, fingerprint, entries }
        return entries
      })

    /**
     * The absolute path to load into Chromium's native PDF viewer, or a refusal.
     *
     * NOT `revealPath`. Containment alone is the wrong bar for this door: the
     * native view renders a `file://` document with the whole worktree as its
     * origin's neighbourhood, so pointing it at an agent-authored `.html` gives
     * that page the ability to pull in local subresources. The renderer gating
     * on `kind === "pdf"` is exactly the trust this module exists not to extend,
     * so the kind and regular-file checks are repeated HERE, where they bind.
     */
    const pdfPath = (
      worktree: string,
      requested: string
    ): Effect.Effect<
      string,
      AssetOutsideWorktreeError | AssetUnsupportedError,
      AssetEnv
    > =>
      Effect.gen(function* () {
        if (extensionToKind(requested) !== "pdf") {
          return yield* new AssetUnsupportedError({ path: requested })
        }
        const { absolutePath } = yield* resolveInside(worktree, requested)
        const info = yield* fs.stat(absolutePath).pipe(
          Effect.mapError(() => new AssetOutsideWorktreeError({ path: requested, reason: "unreadable" }))
        )
        if (info.type !== "File") {
          return yield* new AssetOutsideWorktreeError({ path: requested, reason: "not-a-file" })
        }
        return absolutePath
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

    return { list, read, pdfPath, revealPath } as const
  })
}) {}

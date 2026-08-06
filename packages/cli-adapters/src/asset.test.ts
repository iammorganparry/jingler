import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect, Exit, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AssetService } from "./asset.js"
import { failureOf, mkTemp } from "./test-support.js"

/**
 * The asset read path, against a real temp filesystem.
 *
 * The point of this file is the containment check. Every path `read` receives
 * came out of agent output, so a traversal is an expected input rather than an
 * edge case — and a bug here is "an agent transcript can exfiltrate your SSH
 * key", not "a viewer showed the wrong file". The traversal cases below are the
 * ones a real attempt would use: `..` segments, an absolute path, and a symlink
 * planted inside the worktree, which is the one that defeats a textual check.
 */

let worktree: ReturnType<typeof mkTemp>
let outside: ReturnType<typeof mkTemp>

beforeEach(() => {
  worktree = mkTemp("jingler-worktree-")
  outside = mkTemp("jingler-outside-")
  writeFileSync(join(outside.dir, "secret.txt"), "SUPER SECRET")
})
afterEach(() => {
  worktree.cleanup()
  outside.cleanup()
})

/**
 * `provideMerge`, not `mergeAll`: the service's own layer REQUIRES
 * FileSystem/Path, so merging the two side by side leaves that requirement
 * unsatisfied and every call dies with a missing-service defect — which reads
 * as "the effect failed" and would make the containment assertions below pass
 * for entirely the wrong reason.
 */
const TestLayer = AssetService.Default.pipe(Layer.provideMerge(NodeContext.layer))

const run = <A, E>(effect: Effect.Effect<A, E, AssetService | NodeContext.NodeContext>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(TestLayer)))

/**
 * The `_tag` of a run's typed failure, or null when it succeeded. Asserting on
 * the tag rather than on `isFailure` is what makes "refused for the RIGHT
 * reason" testable — a traversal that failed because the temp dir was missing
 * would otherwise read as a pass.
 */
const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | null => {
  const failure = failureOf(exit)
  return failure === undefined ? null : ((failure as { _tag?: string })._tag ?? "untagged")
}

const readAsset = (path: string) =>
  run(Effect.flatMap(AssetService, (s) => s.read(worktree.dir, path)))

const listAssets = () =>
  run(Effect.flatMap(AssetService, (s) => s.list(worktree.dir)))

const writeAsset = (
  path: string,
  text: string,
  expectedRevision: string
) =>
  run(
    Effect.flatMap(AssetService, (s) =>
      s.write(worktree.dir, path, text, expectedRevision)
    )
  )

describe("AssetService.read — containment", () => {
  it("refuses a `..` traversal out of the worktree", async () => {
    const exit = await readAsset(`../${outside.dir.split("/").pop()}/secret.txt`)
    expect(failureTag(exit)).toBe("AssetOutsideWorktreeError")
  })

  it("refuses an absolute path outside the worktree", async () => {
    const exit = await readAsset(join(outside.dir, "secret.txt"))
    expect(failureTag(exit)).toBe("AssetOutsideWorktreeError")
  })

  it("refuses a SYMLINK inside the worktree that points outside it", async () => {
    // The case a textual `resolve()` check passes: the path string stays inside
    // the worktree and the escape happens in the filesystem. Only comparing
    // realpaths catches it.
    symlinkSync(join(outside.dir, "secret.txt"), join(worktree.dir, "notes.md"))
    const exit = await readAsset("notes.md")
    expect(failureTag(exit)).toBe("AssetOutsideWorktreeError")
  })

  it("refuses a sibling directory that merely shares the worktree's prefix", async () => {
    // `startsWith(root)` without a separator would let `/tmp/wt-evil` pass for
    // a worktree at `/tmp/wt`.
    const sibling = `${worktree.dir}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, "secret.md"), "nope")
    const exit = await readAsset(join(sibling, "secret.md"))
    expect(failureTag(exit)).toBe("AssetOutsideWorktreeError")
  })

  it("allows a nested file that really is inside", async () => {
    mkdirSync(join(worktree.dir, "docs"), { recursive: true })
    writeFileSync(join(worktree.dir, "docs", "spec.md"), "# Spec")
    const exit = await readAsset("docs/spec.md")
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("AssetService.read — payloads", () => {
  it("returns markdown as text, with no language", async () => {
    writeFileSync(join(worktree.dir, "notes.md"), "# Hello")
    const exit = await readAsset("notes.md")
    expect(exit).toMatchObject({
      _tag: "Success",
      value: { kind: "markdown", text: "# Hello", language: null, path: "notes.md" }
    })
  })

  it("names the Shiki language for code", async () => {
    writeFileSync(join(worktree.dir, "main.ts"), "export const a = 1\n")
    const exit = await readAsset("main.ts")
    expect(exit).toMatchObject({ _tag: "Success", value: { kind: "code", language: "typescript" } })
  })

  it("loads a valid UTF-8 file with an unknown extension as editable text", async () => {
    writeFileSync(join(worktree.dir, "settings.widgetrc"), "feature = true\n")
    const exit = await readAsset("settings.widgetrc")
    expect(exit).toMatchObject({
      _tag: "Success",
      value: {
        kind: "text",
        language: null,
        text: "feature = true\n",
        revision: expect.stringMatching(/^sha256:/)
      }
    })
  })

  it("base64s an image and names its media type", async () => {
    // A one-pixel PNG, so the assertion is on real bytes rather than a stub.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    )
    writeFileSync(join(worktree.dir, "dot.png"), png)
    const exit = await readAsset("dot.png")
    expect(exit).toMatchObject({
      _tag: "Success",
      value: { kind: "image", mediaType: "image/png", base64: png.toString("base64") }
    })
  })

  it("ships NO bytes for a PDF — Chromium loads it off disk", async () => {
    writeFileSync(join(worktree.dir, "report.pdf"), "%PDF-1.4 fake")
    const exit = await readAsset("report.pdf")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.kind).toBe("pdf")
      expect(exit.value).not.toHaveProperty("base64")
      expect(exit.value).not.toHaveProperty("text")
      expect(exit.value.absolutePath).toContain("report.pdf")
    }
  })

  it("reports the path worktree-relative, whatever form was requested", async () => {
    mkdirSync(join(worktree.dir, "out"), { recursive: true })
    writeFileSync(join(worktree.dir, "out", "results.csv"), "a,b\n1,2\n")
    const exit = await readAsset(join(worktree.dir, "out", "results.csv"))
    expect(exit).toMatchObject({ _tag: "Success", value: { path: "out/results.csv", kind: "csv" } })
  })
})

describe("AssetService.read — refusals that are not traversals", () => {
  it("refuses unknown-extension binary data rather than decoding it as text", async () => {
    writeFileSync(join(worktree.dir, "app.wasm"), Buffer.from([0, 255, 0, 1]))
    const exit = await readAsset("app.wasm")
    expect(failureTag(exit)).toBe("AssetBinaryError")
  })

  it("refuses a file over its kind's cap instead of loading it", async () => {
    // 6 MB of markdown against a 5 MB cap. Reading first and checking after
    // would already have spent the memory.
    writeFileSync(join(worktree.dir, "huge.md"), "x".repeat(6 * 1024 * 1024))
    const exit = await readAsset("huge.md")
    expect(failureTag(exit)).toBe("AssetTooLargeError")
  })

  it("refuses a DIRECTORY that happens to be named like an asset", async () => {
    mkdirSync(join(worktree.dir, "report.pdf"), { recursive: true })
    const exit = await readAsset("report.pdf")
    expect(failureTag(exit)).toBe("AssetOutsideWorktreeError")
  })

  it("fails cleanly when the worktree itself does not exist", async () => {
    const exit = await run(
      Effect.flatMap(AssetService, (s) => s.read("/nope/not/a/worktree", "a.md"))
    )
    expect(failureTag(exit)).toBe("AssetOutsideWorktreeError")
  })
})

describe("AssetService.write — contained compare-and-swap edits", () => {
  it("saves an existing UTF-8 file and returns its refreshed revision", async () => {
    const file = join(worktree.dir, "config.unknown")
    writeFileSync(file, "before\n")
    const loaded = await readAsset("config.unknown")
    expect(Exit.isSuccess(loaded)).toBe(true)
    if (!Exit.isSuccess(loaded) || loaded.value.kind === "image" || loaded.value.kind === "pdf") {
      return
    }

    const saved = await writeAsset(
      "config.unknown",
      "after\n",
      loaded.value.revision
    )
    expect(saved).toMatchObject({
      _tag: "Success",
      value: {
        path: "config.unknown",
        kind: "text",
        text: "after\n"
      }
    })
    if (Exit.isSuccess(saved)) {
      expect(saved.value.revision).not.toBe(loaded.value.revision)
    }
    expect(readFileSync(file, "utf8")).toBe("after\n")
  })

  it("refuses a stale revision without overwriting the external edit", async () => {
    const file = join(worktree.dir, "notes.md")
    writeFileSync(file, "loaded\n")
    const loaded = await readAsset("notes.md")
    expect(Exit.isSuccess(loaded)).toBe(true)
    if (!Exit.isSuccess(loaded) || loaded.value.kind === "image" || loaded.value.kind === "pdf") {
      return
    }

    writeFileSync(file, "agent changed this\n")
    const saved = await writeAsset(
      "notes.md",
      "renderer change\n",
      loaded.value.revision
    )
    expect(failureTag(saved)).toBe("AssetWriteConflictError")
    expect(readFileSync(file, "utf8")).toBe("agent changed this\n")
  })

  it("atomically replaces content while preserving the file mode", async () => {
    const file = join(worktree.dir, "script.custom")
    writeFileSync(file, "before\n")
    chmodSync(file, 0o640)
    const before = statSync(file)
    const loaded = await readAsset("script.custom")
    expect(Exit.isSuccess(loaded)).toBe(true)
    if (!Exit.isSuccess(loaded) || loaded.value.kind === "image" || loaded.value.kind === "pdf") {
      return
    }

    const saved = await writeAsset(
      "script.custom",
      "after\n",
      loaded.value.revision
    )

    expect(Exit.isSuccess(saved)).toBe(true)
    const after = statSync(file)
    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o777).toBe(before.mode & 0o777)
    expect(readFileSync(file, "utf8")).toBe("after\n")
    expect(readdirSync(worktree.dir).filter((name) => name.includes(".jingler-"))).toEqual([])
  })

  it("refuses traversal and an escaping symlink at save time", async () => {
    const outsideFile = join(outside.dir, "secret.txt")
    const traversal = `../${outside.dir.split("/").pop()}/secret.txt`
    expect(failureTag(await writeAsset(traversal, "nope", "stale"))).toBe(
      "AssetOutsideWorktreeError"
    )

    symlinkSync(outsideFile, join(worktree.dir, "escape.unknown"))
    expect(
      failureTag(await writeAsset("escape.unknown", "nope", "stale"))
    ).toBe("AssetOutsideWorktreeError")
    expect(readFileSync(outsideFile, "utf8")).toBe("SUPER SECRET")
  })

  it("refuses binary edits and never creates a missing path", async () => {
    writeFileSync(
      join(worktree.dir, "payload.custom"),
      Buffer.from([0, 255, 0, 1])
    )
    expect(
      failureTag(await writeAsset("payload.custom", "text", "stale"))
    ).toBe("AssetBinaryError")

    const missing = join(worktree.dir, "new-file.txt")
    expect(
      failureTag(await writeAsset("new-file.txt", "new", "stale"))
    ).toBe("AssetOutsideWorktreeError")
    expect(existsSync(missing)).toBe(false)
  })
})

describe("AssetService.pdfPath — the SECOND door into the filesystem", () => {
  const pdfPath = (path: string) =>
    run(Effect.flatMap(AssetService, (s) => s.pdfPath(worktree.dir, path)))

  it("returns the absolute path for a real PDF", async () => {
    writeFileSync(join(worktree.dir, "report.pdf"), "%PDF-1.4 fake")
    const exit = await pdfPath("report.pdf")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toContain("report.pdf")
  })

  it("refuses a non-PDF, even one inside the worktree", async () => {
    // The finding this pins: containment alone is the wrong bar here. The native
    // view renders a `file://` DOCUMENT, so pointing it at agent-authored HTML
    // would give that page a file origin and the local subresources that come
    // with it. A compromised renderer asking for `.html` must be refused in MAIN,
    // not merely discouraged by the renderer gating on `kind === "pdf"`.
    writeFileSync(join(worktree.dir, "evil.html"), "<script>fetch('//x')</script>")
    expect(failureTag(await pdfPath("evil.html"))).toBe("AssetUnsupportedError")
    writeFileSync(join(worktree.dir, "notes.md"), "# hi")
    expect(failureTag(await pdfPath("notes.md"))).toBe("AssetUnsupportedError")
  })

  it("refuses a traversal exactly as a read does", async () => {
    symlinkSync(join(outside.dir, "secret.txt"), join(worktree.dir, "escape.pdf"))
    expect(failureTag(await pdfPath("escape.pdf"))).toBe("AssetOutsideWorktreeError")
  })

  it("refuses a DIRECTORY named like a PDF", async () => {
    mkdirSync(join(worktree.dir, "dir.pdf"), { recursive: true })
    expect(failureTag(await pdfPath("dir.pdf"))).toBe("AssetOutsideWorktreeError")
  })
})

describe("AssetService.list — Git-aware repository discovery", () => {
  const git = (args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd: worktree.dir, stdio: "ignore" })

  it("returns canonical tracked and non-ignored untracked files with status", async () => {
    git(["init"])
    git(["config", "user.email", "test@jingler.dev"])
    git(["config", "user.name", "Jingler Test"])
    mkdirSync(join(worktree.dir, "src"), { recursive: true })
    writeFileSync(join(worktree.dir, ".gitignore"), "ignored.log\n")
    writeFileSync(join(worktree.dir, "README.md"), "# Clean\n")
    writeFileSync(join(worktree.dir, "old-name.txt"), "rename me\n")
    writeFileSync(join(worktree.dir, "src", "main.ts"), "export const value = 1\n")
    writeFileSync(join(worktree.dir, " leading-space.txt"), "preserve my name\n")
    git(["add", "-A"])
    git(["commit", "-m", "seed", "--no-gpg-sign"])

    writeFileSync(join(worktree.dir, "src", "main.ts"), "export const value = 2\n")
    git(["mv", "old-name.txt", "renamed.txt"])
    writeFileSync(join(worktree.dir, "added.txt"), "staged\n")
    git(["add", "added.txt"])
    writeFileSync(join(worktree.dir, "notes.md"), "untracked\n")
    writeFileSync(join(worktree.dir, "ignored.log"), "build spew\n")
    symlinkSync(join(outside.dir, "secret.txt"), join(worktree.dir, "escape.txt"))
    git(["add", "escape.txt"])

    const exit = await listAssets()
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return

    expect(exit.value).toEqual([
      { path: " leading-space.txt", status: "clean" },
      { path: ".gitignore", status: "clean" },
      { path: "added.txt", status: "added" },
      { path: "notes.md", status: "untracked" },
      { path: "README.md", status: "clean" },
      { path: "renamed.txt", status: "renamed" },
      { path: "src/main.ts", status: "modified" }
    ])
    expect(exit.value.some((entry) => entry.path.startsWith(".git/"))).toBe(false)
    expect(exit.value.some((entry) => entry.path === "ignored.log")).toBe(false)
    expect(exit.value.some((entry) => entry.path === "escape.txt")).toBe(false)
    expect(exit.value.some((entry) => entry.path === "old-name.txt")).toBe(false)
  })

  it("fails with GitError instead of crawling a non-repository directory", async () => {
    expect(failureTag(await listAssets())).toBe("GitError")
  })

  it("lists a large repository completely without including ignored build output", async () => {
    git(["init"])
    writeFileSync(join(worktree.dir, ".gitignore"), "build/\n")
    const count = 1_200
    for (let directory = 0; directory < 12; directory += 1) {
      const root = join(worktree.dir, "packages", `group-${directory}`)
      mkdirSync(root, { recursive: true })
      for (let file = 0; file < 100; file += 1) {
        writeFileSync(join(root, `file-${file}.ts`), `export const value = ${file}\n`)
      }
    }
    mkdirSync(join(worktree.dir, "build"), { recursive: true })
    writeFileSync(join(worktree.dir, "build", "bundle.js"), "ignored\n")

    const exit = await listAssets()
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return

    expect(exit.value).toHaveLength(count + 1)
    expect(exit.value.filter((entry) => entry.status === "untracked")).toHaveLength(
      count + 1
    )
    expect(exit.value.some((entry) => entry.path === "build/bundle.js")).toBe(false)
    expect(new Set(exit.value.map((entry) => entry.path)).size).toBe(exit.value.length)
  })
})

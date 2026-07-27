import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
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
  it("refuses an extension with no viewer rather than showing bytes as text", async () => {
    writeFileSync(join(worktree.dir, "app.wasm"), "\0\0binary")
    const exit = await readAsset("app.wasm")
    expect(failureTag(exit)).toBe("AssetUnsupportedError")
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

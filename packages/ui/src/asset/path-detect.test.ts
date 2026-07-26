import { describe, expect, it } from "vitest"
import { isOpenablePath, normalizeCandidate, resolveOpenablePath } from "./path-detect.js"

/**
 * The false-positive gate.
 *
 * This runs against every inline code span in every transcript, so the failure
 * mode that matters is not "missed a path" — it is "turned `v1.2.3` into a link
 * that opens an error". A transcript where a third of the tokens are dead
 * affordances is worse than one with no links at all, so every case below that
 * expects `null` is load-bearing.
 */
const FILES = new Set([
  "docs/spec.md",
  "src/index.ts",
  "out/results.csv",
  "assets/chart.png",
  "report.pdf",
  "package.json",
  "README.md"
])

describe("resolveOpenablePath — accepts", () => {
  it("a worktree-relative path that exists", () => {
    expect(resolveOpenablePath("docs/spec.md", FILES)).toBe("docs/spec.md")
    expect(resolveOpenablePath("assets/chart.png", FILES)).toBe("assets/chart.png")
  })

  it("a `./`-prefixed path, which git lists without the prefix", () => {
    expect(resolveOpenablePath("./docs/spec.md", FILES)).toBe("docs/spec.md")
  })

  it("a path with a line suffix, opening the file itself", () => {
    // Agents write `src/index.ts:42` constantly. The line number is not part of
    // the filename and must not defeat the lookup.
    expect(resolveOpenablePath("src/index.ts:42", FILES)).toBe("src/index.ts")
    expect(resolveOpenablePath("src/index.ts:42:7", FILES)).toBe("src/index.ts")
  })

  it("an ABSOLUTE path, returned worktree-RELATIVE", () => {
    // Tool calls report absolute paths and git lists relative ones, so the two
    // are matched on a segment boundary — and the relative form is what comes
    // back, because that is the only form `Asset.read` resolves correctly.
    expect(resolveOpenablePath("/Users/x/wt/docs/spec.md", FILES)).toBe("docs/spec.md")
  })

  it("a ROOT-relative href, which is how markdown delivers `./docs/spec.md`", () => {
    expect(resolveOpenablePath("/docs/spec.md", FILES)).toBe("docs/spec.md")
  })

  it("a file at the worktree root", () => {
    expect(resolveOpenablePath("README.md", FILES)).toBe("README.md")
  })
})

describe("resolveOpenablePath — refuses", () => {
  it("a version string", () => {
    expect(resolveOpenablePath("v1.2.3", FILES)).toBeNull()
  })

  it("a dotted identifier that is not a file", () => {
    expect(resolveOpenablePath("npm.install", FILES)).toBeNull()
    expect(resolveOpenablePath("foo.bar", FILES)).toBeNull()
  })

  it("a real-looking path that is NOT in this worktree", () => {
    // The whole point of gate three: shape alone would accept this.
    expect(resolveOpenablePath("docs/other.md", FILES)).toBeNull()
    expect(resolveOpenablePath("src/missing.ts", FILES)).toBeNull()
  })

  it("a file we have no viewer for, even when it exists", () => {
    expect(resolveOpenablePath("app.wasm", new Set(["app.wasm"]))).toBeNull()
  })

  it("an http(s) URL — that is a page, not a file", () => {
    expect(resolveOpenablePath("https://example.com/docs/spec.md", FILES)).toBeNull()
    expect(resolveOpenablePath("http://localhost:3000/README.md", FILES)).toBeNull()
  })

  it("an absolute path whose tail merely ENDS WITH a known file", () => {
    // `/w/notspec.md` must not match `docs/spec.md`, and `/w/xdocs/spec.md`
    // must not match either — the suffix has to land on a `/`.
    expect(resolveOpenablePath("/w/xdocs/spec.md", FILES)).toBeNull()
    expect(resolveOpenablePath("/w/notREADME.md", FILES)).toBeNull()
  })

  it("a whole sentence that happens to contain a path", () => {
    expect(resolveOpenablePath("see docs/spec.md for details", FILES)).toBeNull()
  })

  it("anything at all when the worktree file list is empty", () => {
    // An empty set is a real answer — "nothing is openable" — not a reason to
    // fall back to matching on shape.
    expect(resolveOpenablePath("docs/spec.md", new Set())).toBeNull()
  })

  it("degenerate input rather than throwing", () => {
    expect(resolveOpenablePath("", FILES)).toBeNull()
    expect(resolveOpenablePath("   ", FILES)).toBeNull()
    expect(resolveOpenablePath("/", FILES)).toBeNull()
    expect(resolveOpenablePath("...", FILES)).toBeNull()
  })
})

describe("normalizeCandidate", () => {
  it("trims and drops a leading ./", () => {
    expect(normalizeCandidate("  ./a/b.md ")).toBe("a/b.md")
  })

  it("refuses anything carrying a URL scheme", () => {
    expect(normalizeCandidate("file:///etc/passwd")).toBeNull()
    expect(normalizeCandidate("https://x/y.md")).toBeNull()
  })
})

describe("isOpenablePath", () => {
  it("agrees with resolveOpenablePath", () => {
    expect(isOpenablePath("docs/spec.md", FILES)).toBe(true)
    expect(isOpenablePath("v1.2.3", FILES)).toBe(false)
  })
})

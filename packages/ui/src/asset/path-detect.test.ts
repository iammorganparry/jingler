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

  it("a ROOT-relative href even when a worktreeRoot is set", () => {
    // The regression this pins: `[the spec](./docs/spec.md)` reaches us as
    // `/docs/spec.md`, which LOOKS absolute but is worktree-relative. Gating it
    // on `isUnderRoot` refused it outright and silently killed the whole
    // markdown-link route — caught only by the e2e.
    expect(resolveOpenablePath("/docs/spec.md", FILES, "/Users/x/wt")).toBe("docs/spec.md")
  })

  it("still refuses a foreign absolute path that a root-relative read would rescue", () => {
    // The root-relative fallback matches the WHOLE remaining path, so a foreign
    // path cannot sneak through it: `/usr/lib/x/package.json` becomes
    // `usr/lib/x/package.json`, which is not tracked.
    expect(resolveOpenablePath("/usr/lib/x/package.json", FILES, "/Users/x/wt")).toBeNull()
    expect(resolveOpenablePath("/other/proj/src/index.ts", FILES, "/Users/x/wt")).toBeNull()
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

describe("resolveOpenablePath — extensionless known files", () => {
  // `extensionToKind` recognises a handful of dotless basenames (Dockerfile,
  // Makefile). The shape gate used to demand a dot, so these were never clickable
  // even when tracked — the two allow-lists disagreed. They should open now.
  const WITH_DOCKERFILE = new Set(["Dockerfile", "Makefile", "docs/spec.md"])

  it("opens an extensionless file that has a viewer and is tracked", () => {
    expect(resolveOpenablePath("Dockerfile", WITH_DOCKERFILE)).toBe("Dockerfile")
    expect(resolveOpenablePath("Makefile", WITH_DOCKERFILE)).toBe("Makefile")
  })

  it("refuses those same names when the worktree does not track them", () => {
    expect(resolveOpenablePath("Dockerfile", FILES)).toBeNull()
    expect(resolveOpenablePath("Makefile", FILES)).toBeNull()
  })

  it("still refuses a bare word we have no viewer for, even when tracked", () => {
    // The regression the relaxed shape must not introduce: an ordinary word is
    // path-shaped, so only gate two (no viewer) keeps it inert.
    expect(resolveOpenablePath("randomword", new Set(["randomword"]))).toBeNull()
  })
})

describe("resolveOpenablePath — worktree root", () => {
  const ROOT = "/Users/x/wt"

  it("opens an absolute path inside the root, returned worktree-relative", () => {
    expect(resolveOpenablePath("/Users/x/wt/docs/spec.md", FILES, ROOT)).toBe("docs/spec.md")
  })

  it("refuses an absolute path OUTSIDE the root whose tail matches a tracked file", () => {
    // The foreign-repo bug: each ends in one of our relative paths but belongs to
    // a different checkout, so opening this worktree's copy is confidently wrong.
    expect(resolveOpenablePath("/other/proj/docs/spec.md", FILES, ROOT)).toBeNull()
    expect(resolveOpenablePath("/usr/lib/node_modules/x/package.json", FILES, ROOT)).toBeNull()
  })

  it("does not count a sibling dir that merely shares the root's prefix", () => {
    expect(resolveOpenablePath("/Users/x/wt-other/docs/spec.md", FILES, ROOT)).toBeNull()
  })

  it("keeps the permissive suffix match when no root is supplied", () => {
    // Storybook and the component tests mount no root; behaviour is unchanged.
    expect(resolveOpenablePath("/anywhere/at/all/docs/spec.md", FILES)).toBe("docs/spec.md")
  })

  it("tolerates a trailing slash on the root", () => {
    expect(resolveOpenablePath("/Users/x/wt/docs/spec.md", FILES, "/Users/x/wt/")).toBe("docs/spec.md")
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

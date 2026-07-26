import { describe, expect, it } from "vitest"
import { ASSET_SIZE_CAP, extensionToKind, extensionToLanguage } from "./asset.js"

/**
 * `extensionToKind` is load-bearing twice over: main picks its read strategy
 * from it, and the renderer decides whether a path in agent output is even
 * clickable from it. If the two ever disagreed you'd get links that open an
 * error, so the contract this file pins is "one pure function, both callers".
 */
describe("extensionToKind", () => {
  it("maps the four viewer families", () => {
    expect(extensionToKind("docs/spec.md")).toBe("markdown")
    expect(extensionToKind("src/index.ts")).toBe("code")
    expect(extensionToKind("out/results.csv")).toBe("csv")
    expect(extensionToKind("assets/chart.png")).toBe("image")
    expect(extensionToKind("report.pdf")).toBe("pdf")
    expect(extensionToKind("build.log")).toBe("text")
  })

  it("is case-insensitive — agents write IMG_1234.PNG", () => {
    expect(extensionToKind("IMG_1234.PNG")).toBe("image")
    expect(extensionToKind("README.MD")).toBe("markdown")
  })

  it("returns null for anything with no viewer", () => {
    // The gate for step 06: an unknown extension stays inert text.
    expect(extensionToKind("app.wasm")).toBeNull()
    expect(extensionToKind("archive.tar.gz")).toBeNull()
    expect(extensionToKind("binary.exe")).toBeNull()
  })

  it("does not mistake a version string for a path", () => {
    // `v1.2.3` and `npm.install` reach this function from inline code spans.
    expect(extensionToKind("v1.2.3")).toBeNull()
    expect(extensionToKind("npm.install")).toBeNull()
  })

  it("resolves extension-less names agents actually write", () => {
    expect(extensionToKind("Dockerfile")).toBe("code")
    expect(extensionToKind("Makefile")).toBe("code")
    expect(extensionToKind("LICENSE")).toBe("text")
    expect(extensionToKind("README")).toBe("markdown")
  })

  it("treats a dotfile's only dot as leading, not as an extension", () => {
    // `.gitignore` has no extension; splitting on the last dot naively yields
    // "gitignore" as an extension and misses. Dotfiles are plain text.
    expect(extensionToKind(".gitignore")).toBe("text")
    expect(extensionToKind(".env")).toBe("text")
  })

  it("reads the basename, not the directory", () => {
    // A directory segment containing a dot must not decide the kind.
    expect(extensionToKind("my.app/src/main.ts")).toBe("code")
    expect(extensionToKind("v2.0/notes.md")).toBe("markdown")
  })

  it("tolerates degenerate input rather than throwing", () => {
    expect(extensionToKind("")).toBeNull()
    expect(extensionToKind("/")).toBeNull()
    expect(extensionToKind("dir/")).toBeNull()
  })
})

describe("extensionToLanguage", () => {
  it("aliases extensions whose Shiki id differs", () => {
    expect(extensionToLanguage("a.ts")).toBe("typescript")
    expect(extensionToLanguage("a.mjs")).toBe("javascript")
    expect(extensionToLanguage("a.yml")).toBe("yaml")
    expect(extensionToLanguage("a.rs")).toBe("rust")
    expect(extensionToLanguage("a.patch")).toBe("diff")
  })

  it("passes through an extension that is already the Shiki id", () => {
    expect(extensionToLanguage("a.json")).toBe("json")
    expect(extensionToLanguage("a.go")).toBe("go")
  })

  it("names the extension-less files that still have a grammar", () => {
    expect(extensionToLanguage("Dockerfile")).toBe("docker")
    expect(extensionToLanguage("Makefile")).toBe("make")
  })

  it("returns null rather than a guess when there is nothing to name", () => {
    // A null here means unhighlighted monospace, which beats Shiki throwing on
    // an unknown grammar.
    expect(extensionToLanguage(".gitignore")).toBeNull()
    expect(extensionToLanguage("LICENSE")).toBeNull()
  })
})

describe("ASSET_SIZE_CAP", () => {
  it("covers every kind, so a read can never look up undefined", () => {
    for (const kind of ["markdown", "code", "text", "csv", "image", "pdf"] as const) {
      expect(ASSET_SIZE_CAP[kind]).toBeGreaterThan(0)
    }
  })

  it("caps text kinds well below binary ones", () => {
    // Text is JSON-encoded across IPC and held as a JS string; images are
    // base64'd into a data URL. PDF bytes never cross the boundary at all.
    expect(ASSET_SIZE_CAP.markdown).toBeLessThan(ASSET_SIZE_CAP.image)
    expect(ASSET_SIZE_CAP.image).toBeLessThan(ASSET_SIZE_CAP.pdf)
  })
})

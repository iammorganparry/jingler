import { describe, expect, it } from "vitest"
import {
  browserPartitionForSession,
  fileUrlFor,
  isHttpUrl,
  toRect
} from "./preview-view.js"

/**
 * The pure guards behind PreviewViewService — URL validation (the pane only
 * loads http/https localhost dev servers) and bounds normalization (Electron's
 * `setBounds` needs integers, and negative sizes must clamp to 0). The
 * WebContentsView lifecycle itself needs a live Electron main process, so it's
 * exercised by the Playwright e2e (previews.spec.ts), not here.
 */
describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("http://localhost:3000")).toBe(true)
    expect(isHttpUrl("https://example.com/app")).toBe(true)
    expect(isHttpUrl("http://127.0.0.1:5173/")).toBe(true)
  })

  it("rejects non-http(s) schemes and garbage", () => {
    expect(isHttpUrl("file:///etc/passwd")).toBe(false)
    expect(isHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isHttpUrl("ftp://host/file")).toBe(false)
    expect(isHttpUrl("about:blank")).toBe(false)
    expect(isHttpUrl("localhost:3000")).toBe(false) // no scheme → not a valid URL
    expect(isHttpUrl("")).toBe(false)
    expect(isHttpUrl("not a url")).toBe(false)
  })
})

describe("toRect", () => {
  it("rounds fractional pixels to integers", () => {
    expect(toRect({ x: 10.4, y: 20.6, width: 100.5, height: 200.2 })).toEqual({
      x: 10,
      y: 21,
      width: 101,
      height: 200
    })
  })

  it("clamps negative width/height to 0 (never a negative-size view)", () => {
    expect(toRect({ x: -5, y: -1, width: -20, height: -3 })).toEqual({
      x: -5,
      y: -1,
      width: 0,
      height: 0
    })
  })
})

describe("browserPartitionForSession", () => {
  it("gives each repository session a stable isolated persistent partition", () => {
    expect(browserPartitionForSession("session-alpha")).toBe(
      "persist:jingler-browser-preview:session-alpha"
    )
    expect(browserPartitionForSession("session-alpha")).not.toBe(
      browserPartitionForSession("session-beta")
    )
  })

  it("encodes session ids instead of letting separators alias partitions", () => {
    expect(browserPartitionForSession("team/a:b")).toBe(
      "persist:jingler-browser-preview:team%2Fa%3Ab"
    )
  })
})

/**
 * The browser view's URL guard and the asset view's are deliberately opposite —
 * `isHttpUrl` above rejects `file://`, and the asset view accepts nothing else.
 * These cover the encoding, which is where a hand-rolled `"file://" + path`
 * silently loads the wrong file.
 */
describe("fileUrlFor", () => {
  it("encodes a space rather than producing an unloadable URL", () => {
    expect(fileUrlFor("/tmp/wt/My Report.pdf")).toBe("file:///tmp/wt/My%20Report.pdf")
  })

  it("encodes a # so the path is not truncated at a fragment", () => {
    // `file:///tmp/wt/draft#2.pdf` would load `/tmp/wt/draft` — a different
    // file, or none — and the viewer would show an error nobody could explain.
    expect(fileUrlFor("/tmp/wt/draft#2.pdf")).toBe("file:///tmp/wt/draft%232.pdf")
  })

  it("encodes a ? so the rest of the name is not read as a query", () => {
    expect(fileUrlFor("/tmp/wt/what?.pdf")).toBe("file:///tmp/wt/what%3F.pdf")
  })

  it("leaves an ordinary path alone", () => {
    expect(fileUrlFor("/tmp/wt/docs/report.pdf")).toBe("file:///tmp/wt/docs/report.pdf")
  })

  it("always produces a file: URL that isHttpUrl refuses", () => {
    // The two guards must not overlap: whatever this produces has to be
    // something the browser view would reject outright.
    expect(isHttpUrl(fileUrlFor("/tmp/wt/report.pdf"))).toBe(false)
  })
})

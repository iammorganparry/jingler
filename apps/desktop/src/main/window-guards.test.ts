import { describe, expect, it } from "vitest"
import { isExternallyOpenable, sameOrigin } from "./window-guards.js"

/**
 * What may replace the renderer's document, and what may reach the OS.
 *
 * The stakes are not "a link went to the wrong place". The renderer's
 * `webPreferences` carry the preload that exposes `window.jingler.send/on` —
 * the whole RPC bridge — and Electron hands a `window.open`ed child the
 * OPENER'S preferences. A remote origin that lands on this `webContents`, in a
 * child window or in place, has a live channel to Terminal, Workspace and Auth.
 *
 * Agent markdown renders as real links, so "a page the app never chose" is a
 * routine input here, not a contrived one.
 */
describe("sameOrigin", () => {
  const DEV = "http://localhost:5173/index.html"

  it("allows a reload of the dev server's own origin", () => {
    // Vite does a full page reload whenever HMR can't patch. Refusing that makes
    // the dev loop look broken with nothing reporting why.
    expect(sameOrigin("http://localhost:5173/index.html", DEV)).toBe(true)
    expect(sameOrigin("http://localhost:5173/", DEV)).toBe(true)
    expect(sameOrigin("http://localhost:5173/other", DEV)).toBe(true)
  })

  it("refuses a different host, port or scheme", () => {
    expect(sameOrigin("http://attacker.com/", DEV)).toBe(false)
    expect(sameOrigin("http://localhost:9100/", DEV)).toBe(false)
    expect(sameOrigin("https://localhost:5173/", DEV)).toBe(false)
  })

  it("compares PATHS for file:// — every file URL shares the opaque origin", () => {
    // The trap this exists for: `new URL("file:///etc/passwd").origin` is the
    // string "null", and so is the app bundle's. Comparing origins would make
    // every file on the disk same-origin with the renderer.
    const packaged = "file:///Applications/Jingler.app/Contents/renderer/index.html"
    expect(sameOrigin(packaged, packaged)).toBe(true)
    expect(sameOrigin("file:///etc/passwd", packaged)).toBe(false)
    expect(sameOrigin("file:///Users/me/.ssh/id_rsa", packaged)).toBe(false)
  })

  it("refuses a scheme that is not the document's, even a local one", () => {
    const packaged = "file:///app/renderer/index.html"
    expect(sameOrigin("http://attacker.com/", packaged)).toBe(false)
    expect(sameOrigin("file:///app/renderer/index.html", DEV)).toBe(false)
  })

  it("refuses anything it cannot parse", () => {
    // A URL we can't reason about is not one to navigate to.
    expect(sameOrigin("not a url", DEV)).toBe(false)
    expect(sameOrigin("", DEV)).toBe(false)
    expect(sameOrigin(DEV, "")).toBe(false)
  })
})

describe("isExternallyOpenable", () => {
  it("accepts http and https", () => {
    expect(isExternallyOpenable("https://example.com/docs")).toBe(true)
    expect(isExternallyOpenable("http://localhost:3000")).toBe(true)
  })

  it("refuses every other scheme", () => {
    // `shell.openExternal` launches ANY registered protocol handler, and the URL
    // here came out of agent output.
    expect(isExternallyOpenable("file:///etc/passwd")).toBe(false)
    expect(isExternallyOpenable("javascript:alert(1)")).toBe(false)
    expect(isExternallyOpenable("jingler://auth?token=x")).toBe(false)
    expect(isExternallyOpenable("ms-msdt:/id")).toBe(false)
    expect(isExternallyOpenable("")).toBe(false)
  })
})

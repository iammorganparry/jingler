// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The WebGL addon is the one per-tab GPU allocation, and browsers cap live
 * contexts — so `active` must gate it: hidden cells keep their Terminal (and
 * scrollback) but hold no addon. Everything xterm/rpc is mocked; the assertion
 * is purely about when the addon is constructed and disposed.
 */

const h = vi.hoisted(() => ({
  webglInstances: [] as Array<{ disposed: boolean }>,
  loadedAddons: [] as Array<unknown>
}))

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    loadAddon(addon: unknown) {
      h.loadedAddons.push(addon)
    }
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onData() {
      return { dispose: () => {} }
    }
  }
}))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  }
}))
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }))
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    disposed = false
    constructor() {
      h.webglInstances.push(this)
    }
    onContextLoss() {}
    dispose() {
      this.disposed = true
    }
  }
}))
vi.mock("@xterm/xterm/css/xterm.css", () => ({}))
vi.mock("@jingler/ui", () => ({
  useThemeTokens: () => ({ terminal: {} })
}))
vi.mock("./rpc-client.js", () => ({
  rpc: {
    terminalWrite: async () => {},
    terminalResize: async () => {},
    terminalAttach: () => () => {}
  }
}))

import { XtermView } from "./xterm-view.js"

beforeEach(() => {
  h.webglInstances.length = 0
  h.loadedAddons.length = 0
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("XtermView WebGL gating", () => {
  it("creates no WebGL context for a hidden cell", () => {
    render(<XtermView terminalId="t1" active={false} />)
    expect(h.webglInstances).toHaveLength(0)
  })

  it("creates the context when active, and releases it when hidden again", () => {
    const view = render(<XtermView terminalId="t1" active={true} />)
    expect(h.webglInstances).toHaveLength(1)
    expect(h.webglInstances[0]!.disposed).toBe(false)

    view.rerender(<XtermView terminalId="t1" active={false} />)
    expect(h.webglInstances[0]!.disposed).toBe(true)

    // Reactivating attaches a FRESH addon to the same live terminal.
    view.rerender(<XtermView terminalId="t1" active={true} />)
    expect(h.webglInstances).toHaveLength(2)
    expect(h.webglInstances[1]!.disposed).toBe(false)
  })

  it("defaults to active for callers without a tab strip", () => {
    render(<XtermView terminalId="t1" />)
    expect(h.webglInstances).toHaveLength(1)
  })
})

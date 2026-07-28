import { createActor } from "xstate"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assetTabId, previewDockMachine } from "./preview-dock-machine.js"

/**
 * The dock's chrome rules, driven through the machine rather than a rendered
 * component — these tests run under the node environment, so `localStorage` is a
 * stub. What is asserted is exactly what used to be spread across setters:
 * restore-from-storage, opening showing the dock, dedupe on reopen, and the
 * close-the-focused-tab fallback to the pinned browser tab.
 */
const BROWSER_TAB_ID = "browser"

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear()
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage")
})

const start = () => createActor(previewDockMachine).start()

describe("previewDockMachine", () => {
  it("starts hidden, and TOGGLE flips visibility and persists it", () => {
    const actor = start()
    expect(actor.getSnapshot().matches("hidden")).toBe(true)

    actor.send({ type: "TOGGLE" })
    expect(actor.getSnapshot().matches("shown")).toBe(true)
    expect(store.get("jingler.browser.visible")).toBe("true")

    actor.send({ type: "TOGGLE" })
    expect(actor.getSnapshot().matches("hidden")).toBe(true)
    expect(store.get("jingler.browser.visible")).toBe("false")
  })

  it("REVEAL_BROWSER shows the dock and focuses the browser tab", () => {
    const actor = start()
    // Looking at an asset tab, dock hidden — the state an agent QA call interrupts.
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "docs/a.md" })
    actor.send({ type: "TOGGLE" })
    expect(actor.getSnapshot().matches("hidden")).toBe(true)
    expect(actor.getSnapshot().context.activeId).toBe(assetTabId("s1", "docs/a.md"))

    // An agent drives the browser: the dock opens and the Browser tab is focused.
    actor.send({ type: "REVEAL_BROWSER" })
    expect(actor.getSnapshot().matches("shown")).toBe(true)
    expect(actor.getSnapshot().context.activeId).toBe(BROWSER_TAB_ID)
  })

  it("restores visibility, side and open paths from storage", () => {
    store.set("jingler.browser.visible", "true")
    store.set("jingler.browser.side", "bottom")
    store.set("jingler.preview.tabs", JSON.stringify([{ sessionId: "s1", path: "docs/a.md" }]))

    const snapshot = start().getSnapshot()
    expect(snapshot.matches("shown")).toBe(true)
    expect(snapshot.context.side).toBe("bottom")
    expect(snapshot.context.assets).toEqual([{ sessionId: "s1", path: "docs/a.md" }])
  })

  it("drops malformed restored tabs rather than throwing", () => {
    store.set(
      "jingler.preview.tabs",
      JSON.stringify([{ sessionId: "s1" }, "nope", null, { sessionId: "s2", path: "b.png" }])
    )
    expect(start().getSnapshot().context.assets).toEqual([{ sessionId: "s2", path: "b.png" }])
  })

  it("OPEN_ASSET appends, focuses and shows the dock", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "docs/a.md" })

    const snapshot = actor.getSnapshot()
    expect(snapshot.matches("shown")).toBe(true)
    expect(snapshot.context.activeId).toBe(assetTabId("s1", "docs/a.md"))
    expect(store.get("jingler.preview.tabs")).toBe(
      JSON.stringify([{ sessionId: "s1", path: "docs/a.md" }])
    )
  })

  it("reopening an open asset focuses it instead of duplicating the tab", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "b.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })

    const snapshot = actor.getSnapshot()
    expect(snapshot.context.assets).toHaveLength(2)
    expect(snapshot.context.activeId).toBe(assetTabId("s1", "a.md"))
  })

  it("the same path in a different session is a separate tab", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s2", path: "a.md" })
    expect(actor.getSnapshot().context.assets).toHaveLength(2)
  })

  it("closing the focused tab falls back to the pinned browser tab", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "CLOSE", id: assetTabId("s1", "a.md") })

    const snapshot = actor.getSnapshot()
    expect(snapshot.context.assets).toEqual([])
    expect(snapshot.context.activeId).toBe(BROWSER_TAB_ID)
    // Closing does not hide the dock — the browser tab is still there to show.
    expect(snapshot.matches("shown")).toBe(true)
  })

  it("closing an unfocused tab leaves the selection alone", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "b.md" })
    actor.send({ type: "CLOSE", id: assetTabId("s1", "a.md") })
    expect(actor.getSnapshot().context.activeId).toBe(assetTabId("s1", "b.md"))
  })

  it("CLOSE on the pinned browser tab is a no-op", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "SELECT", id: BROWSER_TAB_ID })
    actor.send({ type: "CLOSE", id: BROWSER_TAB_ID })

    const snapshot = actor.getSnapshot()
    expect(snapshot.context.assets).toHaveLength(1)
    expect(snapshot.context.activeId).toBe(BROWSER_TAB_ID)
  })

  it("assetTabId joins on a space, so paths containing ':' don't collide", () => {
    // Under the old ':' join these two distinct pairs both became "s1:a:b".
    expect(assetTabId("s1", "a:b")).not.toBe(assetTabId("s1:a", "b"))
    // A ':' in the path survives as part of a single, stable id.
    expect(assetTabId("s1", "src/a:b.ts")).toBe("s1 src/a:b.ts")
  })

  it("reopening a path that contains ':' focuses its tab instead of duplicating", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "weird:name.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "weird:name.md" })
    const snapshot = actor.getSnapshot()
    expect(snapshot.context.assets).toHaveLength(1)
    expect(snapshot.context.activeId).toBe(assetTabId("s1", "weird:name.md"))
  })

  it("PRUNE drops tabs whose session isn't live and rewrites storage", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s2", path: "b.md" })

    actor.send({ type: "PRUNE", liveSessionIds: new Set(["s1"]) })

    const snapshot = actor.getSnapshot()
    expect(snapshot.context.assets).toEqual([{ sessionId: "s1", path: "a.md" }])
    expect(store.get("jingler.preview.tabs")).toBe(
      JSON.stringify([{ sessionId: "s1", path: "a.md" }])
    )
  })

  it("PRUNE is a no-op when the live set is empty (sessions not loaded yet)", () => {
    store.set("jingler.preview.tabs", JSON.stringify([{ sessionId: "s1", path: "a.md" }]))
    const actor = start()

    actor.send({ type: "PRUNE", liveSessionIds: new Set() })

    expect(actor.getSnapshot().context.assets).toEqual([{ sessionId: "s1", path: "a.md" }])
    // Storage untouched — the restored tab survives a first load with no sessions.
    expect(store.get("jingler.preview.tabs")).toBe(
      JSON.stringify([{ sessionId: "s1", path: "a.md" }])
    )
  })

  it("PRUNE falls back to the browser when the focused tab's session died", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s2", path: "b.md" })
    // s2's tab is focused; prune leaves only s1.
    actor.send({ type: "PRUNE", liveSessionIds: new Set(["s1"]) })

    const snapshot = actor.getSnapshot()
    expect(snapshot.context.activeId).toBe(BROWSER_TAB_ID)
    expect(snapshot.matches("shown")).toBe(true)
  })

  it("PRUNE leaves the selection alone when the focused tab survives", () => {
    const actor = start()
    actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })
    actor.send({ type: "OPEN_ASSET", sessionId: "s2", path: "b.md" })
    // s2 focused and still live — only the dead s3 (none here) would go.
    actor.send({ type: "PRUNE", liveSessionIds: new Set(["s1", "s2"]) })
    expect(actor.getSnapshot().context.activeId).toBe(assetTabId("s2", "b.md"))
  })

  it("SET_SIDE persists the docked side", () => {
    const actor = start()
    actor.send({ type: "SET_SIDE", side: "bottom" })
    expect(actor.getSnapshot().context.side).toBe("bottom")
    expect(store.get("jingler.browser.side")).toBe("bottom")
  })

  it("survives a localStorage that throws on read and write", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("privacy mode")
        },
        setItem: () => {
          throw new Error("quota")
        }
      }
    })

    const actor = start()
    expect(actor.getSnapshot().matches("hidden")).toBe(true)
    expect(() => actor.send({ type: "OPEN_ASSET", sessionId: "s1", path: "a.md" })).not.toThrow()
    expect(actor.getSnapshot().context.assets).toHaveLength(1)
  })
})

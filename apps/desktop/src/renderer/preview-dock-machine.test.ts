// @vitest-environment node
import { createActor } from "xstate"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { previewDockMachine, previewSessionState } from "./preview-dock-machine.js"

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage")
})

const start = () => createActor(previewDockMachine).start()

describe("previewDockMachine", () => {
  it("keeps URL and dock visibility independent across focused sessions", () => {
    const actor = start()
    actor.send({ type: "FOCUS_SESSION", sessionId: "alpha" })
    actor.send({ type: "TOGGLE" })
    actor.send({ type: "NAVIGATE", sessionId: "alpha", url: "https://alpha.example/page" })
    actor.send({ type: "FOCUS_SESSION", sessionId: "beta" })
    actor.send({ type: "NAVIGATE", sessionId: "beta", url: "https://beta.example/page" })

    const snapshot = actor.getSnapshot()
    expect(previewSessionState(snapshot.context, "alpha")).toMatchObject({
      url: "https://alpha.example/page",
      visible: true
    })
    expect(previewSessionState(snapshot.context, "beta")).toMatchObject({
      url: "https://beta.example/page",
      visible: false
    })
  })

  it("records a background agent reveal without changing the focused session", () => {
    const actor = start()
    actor.send({ type: "FOCUS_SESSION", sessionId: "alpha" })
    actor.send({ type: "TOGGLE" })
    actor.send({
      type: "REVEAL_BROWSER",
      sessionId: "beta",
      url: "https://beta.example/qa"
    })

    const snapshot = actor.getSnapshot()
    expect(snapshot.context.focusedSessionId).toBe("alpha")
    expect(previewSessionState(snapshot.context, "alpha").visible).toBe(true)
    expect(previewSessionState(snapshot.context, "beta")).toMatchObject({
      url: "https://beta.example/qa",
      visible: true,
      source: "native"
    })
  })

  it("routes committed native URLs only to their owning session", () => {
    const actor = start()
    actor.send({ type: "FOCUS_SESSION", sessionId: "alpha" })
    actor.send({ type: "NATIVE_URL", sessionId: "beta", url: "https://beta.example/history" })

    const snapshot = actor.getSnapshot()
    expect(previewSessionState(snapshot.context, "alpha").url).toBe("http://localhost:3000")
    expect(previewSessionState(snapshot.context, "beta").url).toBe(
      "https://beta.example/history"
    )
  })

  it("persists session state and removes only the deleted session", () => {
    const actor = start()
    actor.send({ type: "FOCUS_SESSION", sessionId: "alpha" })
    actor.send({ type: "TOGGLE" })
    actor.send({ type: "FOCUS_SESSION", sessionId: "beta" })
    actor.send({ type: "NAVIGATE", sessionId: "beta", url: "https://beta.example" })
    actor.send({ type: "REMOVE_SESSION", sessionId: "alpha" })

    const restored = start().getSnapshot()
    expect(restored.context.sessions.alpha).toBeUndefined()
    expect(previewSessionState(restored.context, "beta").url).toBe("https://beta.example")
  })

  it("migrates the legacy visibility to the first focused session", () => {
    store.set("jingler.browser.visible", "true")
    store.set("jingler.browser.side", "bottom")
    store.set("jingler.preview.tabs", "legacy assets")
    const actor = start()
    actor.send({ type: "FOCUS_SESSION", sessionId: "alpha" })

    expect(previewSessionState(actor.getSnapshot().context, "alpha").visible).toBe(true)
    expect(actor.getSnapshot().context.side).toBe("bottom")
    expect(store.has("jingler.browser.visible")).toBe(false)
    expect(store.has("jingler.preview.tabs")).toBe(false)
  })

  it("survives localStorage failures", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("privacy mode")
        },
        setItem: () => {
          throw new Error("quota")
        },
        removeItem: () => {
          throw new Error("privacy mode")
        }
      }
    })
    const actor = start()
    expect(() => {
      actor.send({ type: "FOCUS_SESSION", sessionId: "alpha" })
      actor.send({ type: "TOGGLE" })
    }).not.toThrow()
  })
})

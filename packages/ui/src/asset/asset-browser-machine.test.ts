import { createActor } from "xstate"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assetBrowserMachine } from "./asset-browser-machine.js"

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    }
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage")
})

const start = () =>
  createActor(assetBrowserMachine, {
    input: { storageKey: "jingler.asset.tree.test" }
  }).start()

describe("assetBrowserMachine", () => {
  it("turns the docked tree into a closed sheet when constrained", () => {
    const actor = start()
    actor.send({ type: "SET_CONSTRAINED", constrained: true })
    expect(actor.getSnapshot().matches({ constrained: "closed" })).toBe(true)
    actor.send({ type: "TOGGLE_TREE" })
    expect(actor.getSnapshot().matches({ constrained: "open" })).toBe(true)
    actor.send({ type: "SELECT_PATH" })
    expect(actor.getSnapshot().matches({ constrained: "closed" })).toBe(true)
  })

  it("restores the docked tree without losing its persisted width", () => {
    const actor = start()
    actor.send({ type: "START_RESIZE" })
    expect(actor.getSnapshot().context.resizing).toBe(true)
    actor.send({ type: "RESIZE_TREE", delta: 70, max: 380 })
    actor.send({ type: "END_RESIZE" })
    expect(actor.getSnapshot().context.resizing).toBe(false)
    expect(actor.getSnapshot().context.treeWidth).toBe(310)
    expect(values.get("jingler.asset.tree.test")).toBe("310")

    actor.send({ type: "SET_CONSTRAINED", constrained: true })
    actor.send({ type: "SET_CONSTRAINED", constrained: false })
    expect(actor.getSnapshot().matches("roomy")).toBe(true)
    expect(actor.getSnapshot().context.treeWidth).toBe(310)
  })

  it("clamps restored and resized widths so the canvas stays readable", () => {
    values.set("jingler.asset.tree.test", "9999")
    const actor = start()
    expect(actor.getSnapshot().context.treeWidth).toBe(420)
    actor.send({ type: "RESIZE_TREE", delta: -999, max: 380 })
    expect(actor.getSnapshot().context.treeWidth).toBe(180)
  })
})

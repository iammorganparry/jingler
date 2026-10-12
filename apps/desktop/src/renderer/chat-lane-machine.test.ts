// @vitest-environment node
import { createActor } from "xstate"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CHAT_LANE_WIDTH_KEY,
  chatLaneMachine,
  chatLaneView,
  defaultLaneWidth,
  resolveLaneResize
} from "./chat-lane-machine.js"

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

const start = (windowWidth = 1440, contentOpen = false) =>
  createActor(chatLaneMachine, { input: { windowWidth, contentOpen } }).start()
const view = (actor: ReturnType<typeof start>) => chatLaneView(actor.getSnapshot())

describe("chatLaneMachine", () => {
  it("boots Full, Docked or Drawer from the window and content", () => {
    expect(view(start(1440, false)).mode).toBe("full")
    expect(view(start(1440, true)).mode).toBe("docked")
    expect(view(start(1000, true)).mode).toBe("drawer")
    // A narrow window with nothing open still shows the transcript full width.
    expect(view(start(1000, false)).mode).toBe("full")
  })

  it("hands off between Full and Docked as content opens and closes", () => {
    const actor = start()
    actor.send({ type: "OPEN_CONTENT" })
    expect(view(actor)).toMatchObject({ mode: "docked", widthPx: 480 })
    actor.send({ type: "CLOSE_CONTENT" })
    expect(view(actor)).toMatchObject({ mode: "full", widthPx: null })
  })

  it("defaults to clamp(360px, 1/3, 560px)", () => {
    expect(defaultLaneWidth(1000)).toBe(360)
    expect(defaultLaneWidth(1440)).toBe(480)
    expect(defaultLaneWidth(2560)).toBe(560)
  })

  it("snaps a drag to 33% and 50% and leaves other widths alone", () => {
    expect(resolveLaneResize(490, 1440)).toBe(480)
    expect(resolveLaneResize(710, 1440)).toBe(720)
    expect(resolveLaneResize(500, 1440)).toBe(500)
    const actor = start(1440, true)
    actor.send({ type: "RESIZE", width: 725 })
    expect(view(actor).widthPx).toBe(720)
  })

  it("collapses a drag below 320px and ⌘L restores the previous width", () => {
    const actor = start(1440, true)
    actor.send({ type: "RESIZE", width: 600 })
    actor.send({ type: "RESIZE", width: 319 })
    expect(view(actor)).toMatchObject({ mode: "collapsed", showAskPill: true })
    actor.send({ type: "TOGGLE_COLLAPSE" })
    expect(view(actor)).toMatchObject({ mode: "docked", widthPx: 600 })
  })

  it("keeps a drag of exactly 320px docked", () => {
    const actor = start(1440, true)
    actor.send({ type: "RESIZE", width: 320 })
    expect(view(actor)).toMatchObject({ mode: "docked", widthPx: 320 })
  })

  it("toggles Collapsed with ⌘L and closing content returns to Full", () => {
    const actor = start(1440, true)
    actor.send({ type: "TOGGLE_COLLAPSE" })
    expect(view(actor).mode).toBe("collapsed")
    actor.send({ type: "CLOSE_CONTENT" })
    expect(view(actor).mode).toBe("full")
  })

  it("ignores ⌘L and Focus while no content is open", () => {
    const actor = start()
    actor.send({ type: "TOGGLE_COLLAPSE" })
    actor.send({ type: "TOGGLE_FOCUS" })
    expect(view(actor).mode).toBe("full")
  })

  it("Focus hides content and restores Docked", () => {
    const actor = start(1440, true)
    actor.send({ type: "TOGGLE_FOCUS" })
    expect(view(actor)).toMatchObject({ mode: "focus", contentHidden: true })
    actor.send({ type: "TOGGLE_FOCUS" })
    expect(view(actor).mode).toBe("docked")
  })

  it("Focus entered from Collapsed restores Collapsed", () => {
    const actor = start(1440, true)
    actor.send({ type: "TOGGLE_COLLAPSE" })
    actor.send({ type: "TOGGLE_FOCUS" })
    expect(view(actor).mode).toBe("focus")
    actor.send({ type: "TOGGLE_FOCUS" })
    expect(view(actor).mode).toBe("collapsed")
  })

  it("closing the last tab leaves Focus for Full", () => {
    const actor = start(1440, true)
    actor.send({ type: "TOGGLE_FOCUS" })
    actor.send({ type: "CLOSE_CONTENT" })
    expect(view(actor).mode).toBe("full")
  })

  it("becomes a 400px drawer below 1100px and docks again at 1100px", () => {
    const actor = start(1440, true)
    actor.send({ type: "RESIZE", width: 600 })
    actor.send({ type: "WINDOW_RESIZE", width: 1099 })
    expect(view(actor)).toMatchObject({ mode: "drawer", widthPx: 400, drawerOpen: false })
    actor.send({ type: "TOGGLE_COLLAPSE" })
    expect(view(actor).drawerOpen).toBe(true)
    actor.send({ type: "TOGGLE_COLLAPSE" })
    expect(view(actor).drawerOpen).toBe(false)
    actor.send({ type: "WINDOW_RESIZE", width: 1100 })
    expect(view(actor)).toMatchObject({ mode: "docked", widthPx: 600 })
  })

  it("opens content as a drawer in an already-narrow window and closing returns to Full", () => {
    const actor = start(1000, false)
    actor.send({ type: "OPEN_CONTENT" })
    expect(view(actor).mode).toBe("drawer")
    actor.send({ type: "CLOSE_CONTENT" })
    expect(view(actor).mode).toBe("full")
  })

  it("turns Collapsed and Focus into the drawer when the window narrows", () => {
    const collapsed = start(1440, true)
    collapsed.send({ type: "TOGGLE_COLLAPSE" })
    collapsed.send({ type: "WINDOW_RESIZE", width: 900 })
    expect(view(collapsed).mode).toBe("drawer")
    const focus = start(1440, true)
    focus.send({ type: "TOGGLE_FOCUS" })
    focus.send({ type: "WINDOW_RESIZE", width: 900 })
    expect(view(focus).mode).toBe("drawer")
  })

  it("keeps the docked px width across window resizes", () => {
    const actor = start(1440, true)
    actor.send({ type: "RESIZE", width: 420 })
    actor.send({ type: "WINDOW_RESIZE", width: 2560 })
    expect(view(actor).widthPx).toBe(420)
  })

  it("persists the width, restores it on start and resets on double-click", () => {
    const first = start(1440, true)
    first.send({ type: "RESIZE", width: 420 })
    expect(store.get(CHAT_LANE_WIDTH_KEY)).toBe("420")
    expect(view(start(1440, true)).widthPx).toBe(420)
    first.send({ type: "RESET_WIDTH" })
    expect(store.has(CHAT_LANE_WIDTH_KEY)).toBe(false)
    expect(view(first).widthPx).toBe(480)
  })

  it("does not persist a collapsing drag and ignores a stored width under the floor", () => {
    const actor = start(1440, true)
    actor.send({ type: "RESIZE", width: 200 })
    expect(store.has(CHAT_LANE_WIDTH_KEY)).toBe(false)
    store.set(CHAT_LANE_WIDTH_KEY, "100")
    expect(view(start(1440, true)).widthPx).toBe(480)
  })
})

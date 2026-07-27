import { describe, expect, it } from "vitest"
import * as Ui from "./ui.js"
import { UI_EXPORT_NAMES } from "./ui-exports.js"

/**
 * `ui-exports.ts` is hand-written, and this is what makes that safe.
 *
 * Main generates the `@jingler/plugin-sdk/ui` runtime shim from that list
 * rather than from the module itself, because importing the module in the main
 * process would load the entire component library — a syntax highlighter, a
 * maths renderer, a graph layout engine — at startup, to serve a few hundred
 * bytes of re-exports.
 *
 * The cost of that trade is drift, and drift here is invisible in the worst way:
 * add a component to the kit, forget the list, and every plugin importing it
 * gets `undefined` for something that plainly exists in the source. This test is
 * the whole reason the trade is acceptable.
 */

const actual = Object.keys(Ui)
  .filter((name) => name !== "default" && name !== "__esModule")
  .sort()

describe("UI_EXPORT_NAMES", () => {
  it("lists exactly what the UI kit exports", () => {
    expect([...UI_EXPORT_NAMES].sort()).toEqual(actual)
  })

  it("names nothing the module does not export", () => {
    // Reported separately from the above so a failure says WHICH direction is
    // wrong: a stale name serves a shim binding that is undefined at runtime.
    const missing = [...UI_EXPORT_NAMES].filter((name) => !actual.includes(name))
    expect(missing, "listed but not exported").toEqual([])
  })

  it("omits nothing the module does export", () => {
    // The commoner mistake: adding a component and forgetting the list, so
    // plugins cannot import it even though the source says they can.
    const unlisted = actual.filter((name) => !UI_EXPORT_NAMES.includes(name as never))
    expect(unlisted, "exported but not listed").toEqual([])
  })

  it("is sorted, so a diff shows what changed rather than where it moved", () => {
    expect([...UI_EXPORT_NAMES]).toEqual([...UI_EXPORT_NAMES].sort())
  })
})

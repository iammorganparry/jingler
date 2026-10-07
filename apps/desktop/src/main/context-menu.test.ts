import { EventEmitter } from "node:events"
import type { BrowserWindow, MenuItemConstructorOptions } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  writeText: vi.fn()
}))

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  clipboard: { writeText: mocks.writeText }
}))

import { registerTextContextMenu } from "./context-menu.js"

const context = (overrides = {}) => ({
  isEditable: false,
  selectionText: "",
  linkURL: "",
  editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
  frame: {},
  ...overrides
})

const dispatch = (params = context(), defaultPrevented = false) => {
  const webContents = new EventEmitter()
  const window = { webContents } as unknown as BrowserWindow
  registerTextContextMenu(window)
  webContents.emit("context-menu", { defaultPrevented }, params)
  return window
}

const items = (): MenuItemConstructorOptions[] => mocks.buildFromTemplate.mock.calls[0]![0]

describe("registerTextContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildFromTemplate.mockReturnValue({ popup: mocks.popup })
  })

  it("offers native Copy for selected text in the originating window and frame", () => {
    const params = context({ selectionText: "selected chat output" })
    const window = dispatch(params)
    expect(items()).toEqual([{ role: "copy", enabled: true }])
    expect(mocks.popup).toHaveBeenCalledWith({ window, frame: params.frame })
  })

  it("copies a link address using the clipboard action", () => {
    dispatch(context({ linkURL: "https://example.com/docs" }))
    expect(items()).toEqual([{ label: "Copy Link Address", click: expect.any(Function) }])
    // Exercise the stored action; no native menu interaction is required in a unit test.
    Reflect.apply(items()[0]!.click!, undefined, [])
    expect(mocks.writeText).toHaveBeenCalledWith("https://example.com/docs")
  })

  it("keeps Copy and Copy Link Address distinct for selected links", () => {
    dispatch(context({ selectionText: "the docs", linkURL: "https://example.com/docs" }))
    expect(items()).toEqual([
      { role: "copy", enabled: true },
      { type: "separator" },
      { label: "Copy Link Address", click: expect.any(Function) }
    ])
  })

  it("uses renderer edit flags for editable fields without requiring a selection", () => {
    dispatch(context({
      isEditable: true,
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true }
    }))
    expect(items()).toEqual([
      { role: "cut", enabled: false },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
      { role: "selectAll", enabled: true }
    ])
  })

  it("retains whitespace selections and respects disabled Copy", () => {
    dispatch(context({ selectionText: "  ", editFlags: { canCopy: false } }))
    expect(items()).toEqual([{ role: "copy", enabled: false }])
  })

  it("does not open a menu on empty background or an already-handled event", () => {
    dispatch()
    dispatch(context({ selectionText: "already handled" }), true)
    expect(mocks.buildFromTemplate).not.toHaveBeenCalled()
    expect(mocks.popup).not.toHaveBeenCalled()
  })

  it("does not pass a destroyed frame to the native popup", () => {
    const window = dispatch(context({ selectionText: "selected text", frame: null }))
    expect(mocks.popup).toHaveBeenCalledWith({ window, frame: undefined })
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(() => "1.2.3"),
  on: vi.fn()
}))

vi.mock("electron", () => ({
  app: { getVersion: mocks.getVersion },
  ipcMain: { on: mocks.on }
}))

import { APP_VERSION_CHANNEL, registerAppVersionChannel } from "./app-version.js"

describe("registerAppVersionChannel", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns Electron's loaded application version", () => {
    registerAppVersionChannel()
    const handler = mocks.on.mock.calls[0]?.[1]
    const event = { returnValue: "" }

    handler?.(event)

    expect(mocks.on).toHaveBeenCalledWith(APP_VERSION_CHANNEL, expect.any(Function))
    expect(event.returnValue).toBe("1.2.3")
  })
})

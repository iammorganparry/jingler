import { describe, expect, it } from "vitest"
import { resolveDeviceAgentBundlePath } from "./device-agent-bundle.js"

describe("device agent bundle path", () => {
  it("resolves the electron-builder extraResource in a packaged app", () => {
    expect(
      resolveDeviceAgentBundlePath(
        true,
        "/Applications/Jingler.app/Contents/Resources",
        "/ignored"
      )
    ).toBe(
      "/Applications/Jingler.app/Contents/Resources/device-agent/jingler-device.mjs"
    )
  })

  it("resolves the workspace device-agent build for an unpackaged app", () => {
    expect(
      resolveDeviceAgentBundlePath(
        false,
        "/ignored",
        "/repo/apps/desktop/out/main"
      )
    ).toBe("/repo/apps/device-agent/dist/jingler-device.mjs")
  })
})

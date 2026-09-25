import { spawn } from "node:child_process"
import { once } from "node:events"
import { trackChild } from "@jingler/cli-adapters"
import { describe, expect, it, vi } from "vitest"
import { shutdownDeviceAgent } from "./shutdown.js"

describe("device-agent shutdown", () => {
  it.skipIf(process.platform === "win32")("reaps an active native runtime process group before exit", async () => {
    const child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    }), true)
    const closed = once(child, "close")
    const exit = vi.fn()

    expect(shutdownDeviceAgent(exit)).toBe(1)
    expect(exit).toHaveBeenCalledWith(0)
    await closed
  })
})

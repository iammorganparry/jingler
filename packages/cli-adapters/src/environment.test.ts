import type { RemoteDevice } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { environmentFromRemoteDevice } from "./environment.js"

const device: RemoteDevice = {
  version: 1,
  deviceId: "device_clive",
  displayName: "clive.local",
  platform: { os: "darwin", arch: "arm64" },
  publicKey: {
    algorithm: "Ed25519",
    encoding: "base64url",
    value: "A".repeat(43)
  },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["codex"],
    maxConcurrentSessions: 2
  },
  state: "active",
  generation: 3,
  createdAt: 100,
  updatedAt: 200,
  presence: {
    version: 1,
    state: "online",
    connectedAt: 150,
    lastSeenAt: 200,
    activeSessionIds: []
  }
}

describe("environment metadata", () => {
  it("maps registry presence to a renderer-safe environment", () => {
    expect(environmentFromRemoteDevice(device)).toMatchObject({
      id: "device_clive",
      name: "clive.local",
      state: "online",
      lastSeenAt: 200
    })
  })
  it("does not copy grants keys or registry generations into renderer metadata", () => {
    const environment = environmentFromRemoteDevice(device)
    expect(environment).not.toHaveProperty("publicKey")
    expect(environment).not.toHaveProperty("generation")
  })
})

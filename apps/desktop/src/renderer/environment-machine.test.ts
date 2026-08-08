import type { Environment } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { createEnvironmentMachine } from "./environment-machine.js"

const environment: Environment = {
  id: "device_clive",
  name: "clive.local",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["codex"],
    maxConcurrentSessions: 2
  },
  state: "online",
  agentVersion: "1.0.0",
  lastSeenAt: 100
}

const api = () => ({
  suggestHosts: vi.fn(async () => [
    {
      alias: "clive.local",
      hostname: "clive.local",
      username: "morgan",
      port: 22,
      source: "config" as const
    }
  ]),
  pairLink: vi.fn(async () => environment),
  pairSsh: vi.fn(async () => environment)
})

describe("environment machine", () => {
  it("converges remote-link and SSH flows on the claim state", async () => {
    const link = createActor(createEnvironmentMachine(api())).start()
    link.send({ type: "CHOOSE", method: "remote-link" })
    link.send({
      type: "EDIT",
      field: "backendUrl",
      value: "http://localhost:9100"
    })
    link.send({ type: "EDIT", field: "pendingDeviceId", value: "pending_1" })
    link.send({ type: "EDIT", field: "pairingCode", value: "ABCDEFGH" })
    link.send({ type: "SUBMIT" })
    expect(link.getSnapshot().matches("claiming")).toBe(true)
    const ssh = createActor(createEnvironmentMachine(api())).start()
    ssh.send({ type: "CHOOSE", method: "ssh" })
    await waitFor(ssh, (snapshot) => snapshot.matches("configuring"))
    ssh.send({ type: "EDIT", field: "host", value: "clive.local" })
    ssh.send({ type: "SUBMIT" })
    expect(ssh.getSnapshot().matches("claiming")).toBe(true)
  })

  it("pairs an SSH environment once", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    actor.send({ type: "CHOOSE", method: "ssh" })
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "EDIT", field: "host", value: "clive.local" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))
    expect(services.pairSsh).toHaveBeenCalledTimes(1)
  })

  it("returns an expired code failure to editable input", async () => {
    const services = api()
    services.pairLink.mockRejectedValueOnce(new Error("Pairing code expired"))
    const actor = createActor(createEnvironmentMachine(services)).start()
    actor.send({ type: "CHOOSE", method: "remote-link" })
    for (const [field, value] of [
      ["backendUrl", "http://localhost:9100"],
      ["pendingDeviceId", "pending_1"],
      ["pairingCode", "ABCDEFGH"]
    ] as const)
      actor.send({ type: "EDIT", field, value })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("failed"))
    actor.send({ type: "RETRY" })
    expect(actor.getSnapshot().matches("linking")).toBe(true)
    expect(actor.getSnapshot().context.pairingCode).toBe("ABCDEFGH")
  })

  it("cancels without claiming a pending device", () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    actor.send({ type: "CHOOSE", method: "remote-link" })
    actor.send({ type: "CANCEL" })
    expect(actor.getSnapshot().matches("choosing")).toBe(true)
    expect(services.pairLink).not.toHaveBeenCalled()
  })
})

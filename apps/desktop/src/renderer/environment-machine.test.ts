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
  pairSsh: vi.fn(async () => environment)
})

describe("environment machine", () => {
  it("discovers SSH hosts when opened", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    expect(services.suggestHosts).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.hosts[0]?.alias).toBe("clive.local")
  })

  it("pairs an SSH environment once", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "SELECT_HOST", host: (await services.suggestHosts())[0]! })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))
    expect(services.pairSsh).toHaveBeenCalledTimes(1)
    expect(services.pairSsh).toHaveBeenCalledWith({ host: "clive.local" })
  })

  it("returns an SSH failure to editable host configuration", async () => {
    const services = api()
    services.pairSsh.mockRejectedValueOnce(new Error("SSH authentication failed"))
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "EDIT", field: "host", value: "clive.local" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("failed"))
    actor.send({ type: "RETRY" })
    expect(actor.getSnapshot().matches("configuring")).toBe(true)
    expect(actor.getSnapshot().context.host).toBe("clive.local")
  })

  it("cancels without starting bootstrap", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "CANCEL" })
    expect(actor.getSnapshot().matches("configuring")).toBe(true)
    expect(services.pairSsh).not.toHaveBeenCalled()
  })
})

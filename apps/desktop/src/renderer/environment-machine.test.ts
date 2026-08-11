import type { Environment } from "@jingler/core"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { createEnvironmentMachine } from "./environment-machine.js"

const environment: Environment = {
  kind: "owned",
  id: "device_buildbox",
  name: "buildbox",
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

const secondEnvironment: Environment = {
  ...environment,
  id: "device_laptop",
  name: "laptop",
  lastSeenAt: 200
}

const api = () => ({
  list: vi.fn(async () => [] as ReadonlyArray<Environment>),
  refresh: vi.fn(async () => [] as ReadonlyArray<Environment>),
  watch: vi.fn(
    (
      _onEnvironments: (environments: ReadonlyArray<Environment>) => void,
      _onFailure: (error: unknown) => void
    ) => () => undefined
  ),
  suggestHosts: vi.fn(async () => [
    {
      alias: "buildbox",
      hostname: "buildbox",
      username: "developer",
      port: 22,
      source: "config" as const
    }
  ]),
  pairSsh: vi.fn(async () => environment),
  rename: vi.fn(async (_id: string, name: string) => ({
    ...environment,
    name
  })),
  revoke: vi.fn(async () => undefined)
})

describe("environment machine", () => {
  it("loads account-owned devices after authentication", async () => {
    const services = api()
    services.list.mockResolvedValueOnce([environment])
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => !snapshot.context.loading)
    expect(services.list).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.environments).toEqual([environment])
    actor.stop()
  })

  it("retains an offline device in the environment inventory", async () => {
    const services = api()
    const offline = { ...environment, state: "offline" as const }
    services.list.mockResolvedValueOnce([offline])
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => !snapshot.context.loading)
    expect(actor.getSnapshot().context.environments).toEqual([offline])
    actor.stop()
  })

  it("reconciles an account-scoped device presence invalidation", async () => {
    const services = api()
    services.list.mockResolvedValueOnce([
      { ...environment, state: "offline" as const }
    ])
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => !snapshot.context.loading)
    const onEnvironments = services.watch.mock.calls[0]?.[0]
    onEnvironments?.([environment])
    await waitFor(
      actor,
      (snapshot) => snapshot.context.environments[0]?.state === "online"
    )
    expect(actor.getSnapshot().context.environments).toEqual([environment])
    actor.stop()
  })

  it("refreshes account devices through the inventory actor", async () => {
    const services = api()
    services.refresh.mockResolvedValueOnce([environment])
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => !snapshot.context.loading)
    actor.send({ type: "REFRESH" })
    await waitFor(
      actor,
      (snapshot) => snapshot.context.environments.length === 1
    )
    expect(services.refresh).toHaveBeenCalledTimes(1)
    actor.stop()
  })

  it("preserves device order when an environment is renamed", async () => {
    const services = api()
    services.list.mockResolvedValueOnce([environment, secondEnvironment])
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => !snapshot.context.loading)

    actor.send({ type: "RENAME", id: environment.id, name: "builder" })
    await waitFor(
      actor,
      (snapshot) => snapshot.context.environments[0]?.name === "builder"
    )

    expect(actor.getSnapshot().context.environments.map(({ id }) => id)).toEqual(
      [environment.id, secondEnvironment.id]
    )
    actor.stop()
  })

  it("discovers SSH hosts when opened", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    expect(services.suggestHosts).toHaveBeenCalledTimes(1)
    expect(actor.getSnapshot().context.hosts[0]?.alias).toBe("buildbox")
  })

  it("pairs an SSH environment once", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "SELECT_HOST", host: (await services.suggestHosts())[0]! })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))
    expect(services.pairSsh).toHaveBeenCalledTimes(1)
    expect(services.pairSsh).toHaveBeenCalledWith({ host: "buildbox" })
  })

  it("enrolls an owned machine through the SSH bootstrap actor", async () => {
    const services = api()
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "EDIT", field: "host", value: "dev-machine" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))
    expect(actor.getSnapshot().context.environments).toContainEqual(environment)
    actor.stop()
  })

  it("preserves device order when SSH pairing updates an existing device", async () => {
    const services = api()
    services.list.mockResolvedValueOnce([environment, secondEnvironment])
    services.pairSsh.mockResolvedValueOnce({
      ...environment,
      name: "updated-buildbox"
    })
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(
      actor,
      (snapshot) =>
        snapshot.matches("configuring") && !snapshot.context.loading
    )

    actor.send({ type: "EDIT", field: "host", value: "buildbox" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("connected"))

    expect(actor.getSnapshot().context.environments.map(({ id }) => id)).toEqual(
      [environment.id, secondEnvironment.id]
    )
    expect(actor.getSnapshot().context.environments[0]?.name).toBe(
      "updated-buildbox"
    )
    actor.stop()
  })

  it("returns an SSH failure to editable host configuration", async () => {
    const services = api()
    services.pairSsh.mockRejectedValueOnce(new Error("SSH authentication failed"))
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "EDIT", field: "host", value: "buildbox" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("failed"))
    actor.send({ type: "RETRY" })
    expect(actor.getSnapshot().matches("configuring")).toBe(true)
    expect(actor.getSnapshot().context.host).toBe("buildbox")
  })

  it("clears a stale SSH error when the selected host changes", async () => {
    const services = api()
    services.pairSsh.mockRejectedValueOnce(new Error("SSH authentication failed"))
    const actor = createActor(createEnvironmentMachine(services)).start()
    await waitFor(actor, (snapshot) => snapshot.matches("configuring"))
    actor.send({ type: "EDIT", field: "host", value: "unreachable-host" })
    actor.send({ type: "SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("failed"))
    actor.send({
      type: "SELECT_HOST",
      host: (await services.suggestHosts())[0]!
    })
    expect(actor.getSnapshot().context.error).toBeNull()
    expect(actor.getSnapshot().context.host).toBe("buildbox")
    actor.stop()
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

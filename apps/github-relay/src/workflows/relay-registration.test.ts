import { env } from "cloudflare:test"
import type { WorkflowStep } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { runRelayRegistration } from "./relay-registration.js"

const immediateStep = {
  do: async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback()
} as unknown as WorkflowStep

describe("RelayRegistrationWorkflow", () => {
  it("applies a session route mutation idempotently", async () => {
    await runRelayRegistration(
      env,
      {
        kind: "installation-owner",
        mutationId: "registration-owner",
        generation: 1,
        installationId: "8101",
        userId: "user-registration",
        state: "active"
      },
      immediateStep
    )
    const params = {
      kind: "session-route" as const,
      mutation: {
        mutationId: "registration-session",
        generation: 1,
        state: "active" as const,
        installationId: "8101",
        userId: "user-registration",
        repositoryId: "9101",
        pullRequestNumber: 71,
        relaySessionId: "relay-session-registration"
      }
    }
    await expect(runRelayRegistration(env, params, immediateStep)).resolves.toMatchObject({
      applied: true
    })
    await expect(runRelayRegistration(env, params, immediateStep)).resolves.toMatchObject({
      applied: false
    })
  })

  it("archives one session route without removing another route", async () => {
    const routes = env.INSTALLATION_ROUTES.getByName("8102")
    await routes.setOwner("user-registration", "active", "8102", 1, "owner-registration-two")
    for (const [number, relaySessionId] of [
      [81, "relay-session-registration-a"],
      [82, "relay-session-registration-b"]
    ] as const) {
      await routes.applySessionRoute({
        mutationId: `register-${number}`,
        generation: 1,
        state: "active",
        installationId: "8102",
        userId: "user-registration",
        repositoryId: "9102",
        pullRequestNumber: number,
        relaySessionId
      })
    }
    await runRelayRegistration(
      env,
      {
        kind: "session-route",
        mutation: {
          mutationId: "archive-registration-a",
          generation: 2,
          state: "archived",
          installationId: "8102",
          userId: "user-registration",
          repositoryId: "9102",
          pullRequestNumber: 81,
          relaySessionId: "relay-session-registration-a"
        }
      },
      immediateStep
    )
    await expect(routes.resolveRoute("9102", 81)).resolves.toBeNull()
    await expect(routes.resolveRoute("9102", 82)).resolves.toMatchObject({
      relaySessionId: "relay-session-registration-b"
    })
  })

  it("does not let stale owner and route Workflows resurrect removed state", async () => {
    const installationId = "8103"
    const routes = env.INSTALLATION_ROUTES.getByName(installationId)
    const owner = (generation: number, state: "active" | "removed", mutationId: string) =>
      runRelayRegistration(
        env,
        {
          kind: "installation-owner",
          mutationId,
          generation,
          installationId,
          userId: "user-out-of-order",
          state
        },
        immediateStep
      )
    const route = (generation: number, state: "active" | "removed", mutationId: string) =>
      runRelayRegistration(
        env,
        {
          kind: "session-route",
          mutation: {
            mutationId,
            generation,
            state,
            installationId,
            userId: "user-out-of-order",
            repositoryId: "9103",
            pullRequestNumber: 91,
            relaySessionId: "relay-session-out-of-order"
          }
        },
        immediateStep
      )

    await owner(1, "active", "owner-active-1")
    await route(1, "active", "route-active-1")
    await route(3, "removed", "route-removed-3")
    await owner(3, "removed", "owner-removed-3")
    await expect(owner(2, "active", "owner-stale-active-2")).resolves.toMatchObject({
      applied: false
    })
    await expect(route(2, "active", "route-stale-active-2")).resolves.toMatchObject({
      applied: false
    })
    await expect(routes.resolveRoute("9103", 91)).resolves.toBeNull()
    await expect(
      routes.ownsSession("user-out-of-order", "relay-session-out-of-order")
    ).resolves.toBe(false)
  })

  it("moves a relay session to a new tuple without allowing the old tuple to return", async () => {
    const installationId = "8104"
    const routes = env.INSTALLATION_ROUTES.getByName(installationId)
    await routes.setOwner("user-move", "active", installationId, 1, "owner-move")
    const mutation = (
      generation: number,
      repositoryId: string,
      pullRequestNumber: number,
      state: "active" | "removed",
      mutationId: string
    ) => ({
      mutationId,
      generation,
      state,
      installationId,
      userId: "user-move",
      repositoryId,
      pullRequestNumber,
      relaySessionId: "relay-session-identity-move"
    })
    await routes.applySessionRoute(mutation(1, "9104", 101, "active", "move-old-active"))
    await routes.applySessionRoute(mutation(2, "9104", 101, "removed", "move-old-removed"))
    await routes.applySessionRoute(mutation(3, "9105", 102, "active", "move-new-active"))
    await expect(routes.resolveRoute("9104", 101)).resolves.toBeNull()
    await expect(routes.resolveRoute("9105", 102)).resolves.toMatchObject({
      relaySessionId: "relay-session-identity-move"
    })
    await expect(
      routes.applySessionRoute(mutation(1, "9104", 101, "active", "move-stale-old-active"))
    ).resolves.toMatchObject({ applied: false })
    await expect(routes.resolveRoute("9104", 101)).resolves.toBeNull()
  })
})

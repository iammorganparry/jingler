import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

const registerOwnerAndRoute = async (input: {
  readonly installationId: string
  readonly userId: string
  readonly repositoryId: string
  readonly pullRequestNumber: number
  readonly relaySessionId: string
}) => {
  const routes = env.INSTALLATION_ROUTES.getByName(input.installationId)
  await routes.setOwner(
    input.userId,
    "active",
    input.installationId,
    1,
    `owner-${input.relaySessionId}`
  )
  await routes.applySessionRoute({
    mutationId: `route-${input.relaySessionId}`,
    generation: 1,
    state: "active",
    ...input
  })
  return routes
}

describe("session route isolation", () => {
  it("resolves each pull request to a distinct session Durable Object", async () => {
    const routes = await registerOwnerAndRoute({
      installationId: "7001",
      userId: "same-user",
      repositoryId: "9001",
      pullRequestNumber: 41,
      relaySessionId: "relay-session-route-a"
    })
    await routes.applySessionRoute({
      mutationId: "route-relay-session-route-b",
      generation: 1,
      state: "active",
      installationId: "7001",
      userId: "same-user",
      repositoryId: "9001",
      pullRequestNumber: 42,
      relaySessionId: "relay-session-route-b"
    })

    await expect(routes.resolveRoute("9001", 41)).resolves.toMatchObject({
      relaySessionId: "relay-session-route-a"
    })
    await expect(routes.resolveRoute("9001", 42)).resolves.toMatchObject({
      relaySessionId: "relay-session-route-b"
    })
    await expect(routes.ownsSession("same-user", "relay-session-route-a")).resolves.toBe(true)
    await expect(routes.ownsSession("same-user", "relay-session-route-b")).resolves.toBe(true)
  })

  it("archives and removes routes idempotently without affecting another session", async () => {
    const routes = await registerOwnerAndRoute({
      installationId: "7002",
      userId: "same-user",
      repositoryId: "9002",
      pullRequestNumber: 51,
      relaySessionId: "relay-session-archive-a"
    })
    await routes.applySessionRoute({
      mutationId: "route-relay-session-archive-b",
      generation: 1,
      state: "active",
      installationId: "7002",
      userId: "same-user",
      repositoryId: "9002",
      pullRequestNumber: 52,
      relaySessionId: "relay-session-archive-b"
    })
    const archived = {
      mutationId: "archive-session-a",
      generation: 2,
      state: "archived" as const,
      installationId: "7002",
      userId: "same-user",
      repositoryId: "9002",
      pullRequestNumber: 51,
      relaySessionId: "relay-session-archive-a"
    }
    await expect(routes.applySessionRoute(archived)).resolves.toMatchObject({ applied: true })
    await expect(routes.applySessionRoute(archived)).resolves.toMatchObject({ applied: false })
    await expect(routes.resolveRoute("9002", 51)).resolves.toBeNull()
    await expect(routes.resolveRoute("9002", 52)).resolves.toMatchObject({
      relaySessionId: "relay-session-archive-b"
    })
  })

  it("requires active user ownership for a session grant", async () => {
    const routes = await registerOwnerAndRoute({
      installationId: "7003",
      userId: "owned-user",
      repositoryId: "9003",
      pullRequestNumber: 61,
      relaySessionId: "relay-session-owned-1"
    })
    await expect(routes.ownsSession("other-user", "relay-session-owned-1")).resolves.toBe(false)
    await routes.setOwner("owned-user", "suspended", "7003", 2, "suspend-owner")
    await expect(routes.ownsSession("owned-user", "relay-session-owned-1")).resolves.toBe(false)
  })

  it("retries Workflow creation after an interrupted pending admission", async () => {
    const routes = env.INSTALLATION_ROUTES.getByName("7004")
    await expect(
      routes.prepareDeliveryWorkflow("delivery-pending", "workflow-pending")
    ).resolves.toEqual({
      duplicate: false,
      shouldCreate: true,
      workflowId: "workflow-pending"
    })
    await expect(
      routes.prepareDeliveryWorkflow("delivery-pending", "workflow-pending")
    ).resolves.toEqual({ duplicate: true, shouldCreate: true, workflowId: "workflow-pending" })
    await routes.confirmDeliveryWorkflow("delivery-pending")
    await expect(
      routes.prepareDeliveryWorkflow("delivery-pending", "workflow-pending")
    ).resolves.toEqual({ duplicate: true, shouldCreate: false, workflowId: "workflow-pending" })
  })
})

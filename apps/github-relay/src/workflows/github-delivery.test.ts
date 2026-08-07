import { env } from "cloudflare:test"
import type { WorkflowStep } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { normalizedEvent } from "../test-support.js"
import { runGitHubDelivery } from "./github-delivery.js"

class CheckpointStep {
  readonly completed = new Map<string, unknown>()
  readonly executions: string[] = []
  failOnceAt: string | null = null

  asWorkflowStep(): WorkflowStep {
    return {
      do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
        if (this.completed.has(name)) return this.completed.get(name)
        this.executions.push(name)
        if (this.failOnceAt === name) {
          this.failOnceAt = null
          throw new Error("injected workflow step failure")
        }
        const result = await callback()
        this.completed.set(name, result)
        return result
      }
    } as unknown as WorkflowStep
  }
}

const prepareRoute = async (relaySessionId: string, installationId: string) => {
  const routes = env.INSTALLATION_ROUTES.getByName(installationId)
  await routes.setOwner("user-1", "active", installationId, 1, `owner-${relaySessionId}`)
  await routes.applySessionRoute({
    mutationId: `route-${relaySessionId}`,
    generation: 1,
    state: "active",
    userId: "user-1",
    installationId,
    repositoryId: "10",
    pullRequestNumber: 42,
    relaySessionId
  })
}

describe("GitHubDeliveryWorkflow", () => {
  it("resumes from its last successful step after an injected failure", async () => {
    const relaySessionId = "relay-session-retry-0001"
    const installationId = "9901"
    await prepareRoute(relaySessionId, installationId)
    const event = normalizedEvent({
      deliveryId: "workflow-retry-delivery",
      semanticKey: "retry",
      installationId
    })
    const step = new CheckpointStep()
    step.failOnceAt = "persist to current owning session"

    await expect(runGitHubDelivery(env, event, step.asWorkflowStep())).rejects.toThrow(
      "injected workflow step failure"
    )
    await expect(runGitHubDelivery(env, event, step.asWorkflowStep())).resolves.toMatchObject({
      routedSessions: 1,
      relaySessionId
    })
    expect(step.executions.filter((name) => name === "check delivery completion")).toHaveLength(1)
    await expect(env.SESSION_EVENTS.getByName(relaySessionId).eventCount()).resolves.toBe(1)
  })

  it("deduplicates restarted and retried delivery Workflow instances", async () => {
    const relaySessionId = "relay-session-restart-0001"
    const installationId = "9902"
    await prepareRoute(relaySessionId, installationId)
    const event = normalizedEvent({
      deliveryId: "workflow-restart-delivery",
      semanticKey: "restart",
      installationId
    })

    await expect(
      runGitHubDelivery(env, event, new CheckpointStep().asWorkflowStep())
    ).resolves.toMatchObject({ duplicate: false, routedSessions: 1 })
    await expect(
      runGitHubDelivery(env, event, new CheckpointStep().asWorkflowStep())
    ).resolves.toMatchObject({ duplicate: true, routedSessions: 0 })
    await expect(env.SESSION_EVENTS.getByName(relaySessionId).eventCount()).resolves.toBe(1)
  })

  it("does not route an event without an active pull-request session", async () => {
    await expect(
      runGitHubDelivery(
        env,
        normalizedEvent({
          deliveryId: "workflow-zero-route",
          installationId: "9903",
          pullRequest: null
        }),
        new CheckpointStep().asWorkflowStep()
      )
    ).resolves.toEqual({ duplicate: false, routedSessions: 0, relaySessionId: null })
  })

  it("releases admission when route registration still lags after Workflow retries", async () => {
    const installationId = "9904"
    const event = normalizedEvent({ deliveryId: "workflow-registration-lag", installationId })
    const routes = env.INSTALLATION_ROUTES.getByName(installationId)
    await routes.prepareDeliveryWorkflow(event.deliveryId, "delivery-registration-lag")
    await routes.confirmDeliveryWorkflow(event.deliveryId)
    await expect(
      runGitHubDelivery(env, event, new CheckpointStep().asWorkflowStep())
    ).rejects.toThrow("Session route is not registered yet")
    await expect(
      routes.prepareDeliveryWorkflow(event.deliveryId, "delivery-registration-lag")
    ).resolves.toMatchObject({
      duplicate: true,
      shouldCreate: true,
      workflowId: "delivery-registration-lag-retry-1"
    })
  })

  it("revalidates an archived route at the atomic session append boundary", async () => {
    const relaySessionId = "relay-session-stale-route"
    const installationId = "9905"
    await prepareRoute(relaySessionId, installationId)
    const event = normalizedEvent({
      deliveryId: "workflow-stale-route",
      semanticKey: "stale",
      installationId
    })
    const routes = env.INSTALLATION_ROUTES.getByName(installationId)
    const step = {
      do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
        if (name === "persist to current owning session") {
          await routes.applySessionRoute({
            mutationId: "archive-before-session-append",
            generation: 2,
            state: "archived",
            userId: "user-1",
            installationId,
            repositoryId: "10",
            pullRequestNumber: 42,
            relaySessionId
          })
        }
        return callback()
      }
    } as unknown as WorkflowStep
    await expect(runGitHubDelivery(env, event, step)).rejects.toThrow(
      "Session route is not registered yet"
    )
    await expect(env.SESSION_EVENTS.getByName(relaySessionId).eventCount()).resolves.toBe(0)
  })

  it("fans a multi-PR check event into each linked session object", async () => {
    const installationId = "9906"
    await prepareRoute("relay-session-check-a", installationId)
    const routes = env.INSTALLATION_ROUTES.getByName(installationId)
    await routes.applySessionRoute({
      mutationId: "route-relay-session-check-b",
      generation: 1,
      state: "active",
      userId: "user-1",
      installationId,
      repositoryId: "10",
      pullRequestNumber: 43,
      relaySessionId: "relay-session-check-b"
    })
    const firstPullRequest = normalizedEvent().pullRequest!
    const event = normalizedEvent({
      deliveryId: "workflow-multi-pr-check",
      semanticKey: "multi-pr-check",
      installationId,
      event: "check_run",
      actionable: false,
      routePullRequests: [firstPullRequest, { ...firstPullRequest, id: "201", number: 43 }]
    })
    await expect(
      runGitHubDelivery(env, event, new CheckpointStep().asWorkflowStep())
    ).resolves.toMatchObject({ routedSessions: 2 })
    await expect(env.SESSION_EVENTS.getByName("relay-session-check-a").eventCount()).resolves.toBe(1)
    await expect(env.SESSION_EVENTS.getByName("relay-session-check-b").eventCount()).resolves.toBe(1)
  })
})

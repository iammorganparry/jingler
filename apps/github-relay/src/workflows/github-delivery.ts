import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers"
import { relayTelemetry } from "../env.js"
import type { NormalizedGitHubEvent } from "../github-webhook.js"

const retry = {
  retries: { limit: 8, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes"
} as const

export interface GitHubDeliveryResult {
  readonly duplicate: boolean
  readonly routedSessions: number
  readonly relaySessionId: string | null
}

export const runGitHubDelivery = async (
  env: Env,
  event: NormalizedGitHubEvent,
  step: WorkflowStep
): Promise<GitHubDeliveryResult> => {
  const routes = env.INSTALLATION_ROUTES.getByName(event.installationId)
  const alreadyComplete = await step.do("check delivery completion", retry, async () =>
    Boolean(await routes.deliveryCompleted(event.deliveryId))
  )
  if (alreadyComplete) return { duplicate: true, routedSessions: 0, relaySessionId: null }

  const pullRequestNumber = event.pullRequest?.number
  if (pullRequestNumber === undefined) {
    await routes.releaseDeliveryWorkflow(event.deliveryId)
    relayTelemetry("zero_route_delivery", {
      installationId: event.installationId,
      repositoryId: event.repository.id,
      reason: "missing_pull_request"
    })
    return { duplicate: false, routedSessions: 0, relaySessionId: null }
  }

  let publish: {
    readonly routedSessions: number
    readonly insertedSessions: number
    readonly relaySessionIds: readonly string[]
  }
  try {
    publish = await step.do("persist to current owning session", retry, async () => {
      const routed = await routes.routeEvent(event)
      if (!routed) throw new Error("Session route is not registered yet")
      return {
        routedSessions: routed.routedSessions,
        insertedSessions: routed.insertedSessions,
        relaySessionIds: [...routed.relaySessionIds]
      }
    })
  } catch (error) {
    await routes.releaseDeliveryWorkflow(event.deliveryId)
    relayTelemetry("zero_route_delivery", {
      installationId: event.installationId,
      repositoryId: event.repository.id,
      pullRequestNumber
    })
    throw error
  }
  relayTelemetry(publish.insertedSessions > 0 ? "routing_count" : "delivery_deduplicated", {
    installationId: event.installationId,
    repositoryId: event.repository.id,
    pullRequestNumber,
    routedSessions: publish.insertedSessions
  })
  return {
    duplicate: publish.insertedSessions === 0,
    routedSessions: publish.insertedSessions,
    relaySessionId: publish.relaySessionIds[0] ?? null
  }
}

export class GitHubDeliveryWorkflow extends WorkflowEntrypoint<Env, NormalizedGitHubEvent> {
  override run(
    event: Readonly<WorkflowEvent<NormalizedGitHubEvent>>,
    step: WorkflowStep
  ): Promise<GitHubDeliveryResult> {
    return runGitHubDelivery(this.env, event.payload, step)
  }
}

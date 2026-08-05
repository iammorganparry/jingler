import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers"
import type {
  InstallationState,
  SessionRouteMutation
} from "../installation-routes.js"

const retry = {
  retries: { limit: 10, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes"
} as const

export type RelayRegistrationParams =
  | { readonly kind: "session-route"; readonly mutation: SessionRouteMutation }
  | {
      readonly kind: "installation-owner"
      readonly mutationId: string
      readonly generation: number
      readonly installationId: string
      readonly userId: string
      readonly state: InstallationState
    }
  | {
      readonly kind: "installation-lifecycle"
      readonly mutationId: string
      readonly generation: number
      readonly installationId: string
      readonly state: InstallationState
    }

export interface RelayRegistrationResult {
  readonly applied: boolean
  readonly closedSockets: number
  readonly affectedRoutes: number
}

export const runRelayRegistration = async (
  env: Env,
  params: RelayRegistrationParams,
  step: WorkflowStep
): Promise<RelayRegistrationResult> => {
  if (params.kind === "session-route") {
    const result = await step.do("apply session route", retry, async () => {
      const applied = await env.INSTALLATION_ROUTES.getByName(
        params.mutation.installationId
      ).applySessionRoute(params.mutation)
      return { applied: applied.applied, closedSockets: applied.closedSockets }
    })
    return { ...result, affectedRoutes: result.applied ? 1 : 0 }
  }
  if (params.kind === "installation-owner") {
    const result = await step.do("apply installation owner", retry, async () => {
      const applied = await env.INSTALLATION_ROUTES.getByName(params.installationId).setOwner(
        params.userId,
        params.state,
        params.installationId,
        params.generation,
        params.mutationId
      )
      return { applied: applied.applied, closedSockets: applied.closedSockets }
    })
    return { ...result, affectedRoutes: 0 }
  }
  const result = await step.do("apply installation lifecycle", retry, async () => {
    const applied = await env.INSTALLATION_ROUTES.getByName(params.installationId).setAllState(
      params.installationId,
      params.state,
      params.generation,
      params.mutationId
    )
    return { applied: applied.applied, affectedRoutes: applied.affectedRoutes }
  })
  return { applied: result.applied, closedSockets: 0, affectedRoutes: result.affectedRoutes }
}

export class RelayRegistrationWorkflow extends WorkflowEntrypoint<Env, RelayRegistrationParams> {
  override run(
    event: Readonly<WorkflowEvent<RelayRegistrationParams>>,
    step: WorkflowStep
  ): Promise<RelayRegistrationResult> {
    return runRelayRegistration(this.env, event.payload, step)
  }
}

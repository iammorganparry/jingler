import type { Environment, Session } from "@jingler/core"
import {
  CURRENT_RUNTIME_CONTRACTS,
  EnvironmentHandoffError,
  runtimeCapabilitiesMatch
} from "@jingler/core"
import { Effect } from "effect"

/** Facts that make moving the existing checkout unsafe. Deliberately conservative. */
export const sessionContainsWork = (
  session: Session,
  hasTranscript = false
): boolean =>
  hasTranscript ||
  session.diff.added > 0 ||
  session.diff.removed > 0 ||
  session.tokens > 0 ||
  session.costUsd > 0 ||
  session.status !== "idle" ||
  session.semanticBranchPending === false ||
  session.chats.some((chat) => chat.piSessionId !== undefined)

/** A remote target may execute this build only when its pi contracts match exactly. */
export const environmentRuntimeIsCurrent = (environment: Environment): boolean => {
  const runtime = environment.capabilities.runtime
  return runtime !== undefined &&
    runtimeCapabilitiesMatch(
      {
        versions: CURRENT_RUNTIME_CONTRACTS,
        toolIds: [],
        resourceIds: [],
        targetId: environment.id
      },
      runtime
    )
}

export const compatibleEnvironment = (
  session: Session,
  environment: Environment | undefined
): boolean => {
  if (environment === undefined || environment.state !== "online") return false
  const chat = session.chats.find((candidate) => candidate.id === session.activeChatId)
  const connectionId = chat?.connectionId ?? session.connectionId
  const modelId = chat?.modelId ?? session.modelId
  if (connectionId === undefined || modelId === undefined) return false
  // Managed Cloud receives the exact session connection through a short-lived,
  // server-validated capability grant. It intentionally does not advertise the
  // operator's provider account as a device-local saved connection.
  if (environment.kind === "managed") return environmentRuntimeIsCurrent(environment)
  const connection = environment.capabilities.providerConnections?.find(
    (candidate) => candidate.id === connectionId
  )
  return environmentRuntimeIsCurrent(environment) &&
    connection?.status === "authenticated"
}

export interface SessionEnvironmentDependencies<E1, R1, E2, R2, E3, R3> {
  readonly environments: () => Effect.Effect<ReadonlyArray<Environment>, E1, R1>
  readonly persist: (
    sessionId: string,
    environmentId: string | undefined
  ) => Effect.Effect<Session, E2, R2>
  readonly continueSession: (
    source: Session,
    environmentId: string | undefined
  ) => Effect.Effect<Session, E3, R3>
}

const validateTarget = (
  session: Session,
  environmentId: string | undefined,
  environments: ReadonlyArray<Environment>
) => {
  if (environmentId === undefined) return Effect.void
  const environment = environments.find((candidate) => candidate.id === environmentId)
  if (!compatibleEnvironment(session, environment)) {
    return Effect.fail(
      new EnvironmentHandoffError({
        reason: environment?.state === "incompatible" ? "incompatible" : "unavailable",
        message: environment
          ? `${environment.name} does not have a compatible authenticated runtime connection.`
          : "The selected environment is no longer paired.",
        sessionId: session.id,
        environmentId
      })
    )
  }
  return Effect.void
}

/** Reassign only an untouched session; moving an existing checkout would risk data loss. */
export const setSessionEnvironment = <E1, R1, E2, R2, E3, R3>(
  // Generic error/environment channels preserve the caller's typed Effect contract.
  session: Session,
  environmentId: string | undefined,
  dependencies: SessionEnvironmentDependencies<E1, R1, E2, R2, E3, R3>,
  hasTranscript = false
) =>
  Effect.gen(function* () {
    if (sessionContainsWork(session, hasTranscript)) {
      return yield* Effect.fail(
        new EnvironmentHandoffError({
          reason: "has-work",
          message: "This session already contains work. Continue it on the selected environment instead.",
          sessionId: session.id,
          ...(environmentId === undefined ? {} : { environmentId })
        })
      )
    }
    const environments = yield* dependencies.environments()
    yield* validateTarget(session, environmentId, environments)
    return yield* dependencies.persist(session.id, environmentId)
  })

/** Create a continuation only after validating the target; the source is never mutated. */
export const continueSessionOnEnvironment = <E1, R1, E2, R2, E3, R3>(
  source: Session,
  environmentId: string | undefined,
  dependencies: SessionEnvironmentDependencies<E1, R1, E2, R2, E3, R3>
) =>
  Effect.gen(function* () {
    const environments = yield* dependencies.environments()
    yield* validateTarget(source, environmentId, environments)
    return yield* dependencies.continueSession(source, environmentId)
  })

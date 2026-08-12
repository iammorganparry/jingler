import {
  ProviderConnection,
  ProviderModelId,
  type ModelCertification,
  type ReleaseModelCandidate
} from "@jingler/core"
import { Data, Effect, Schema } from "effect"
import { InMemoryProviderCredentialStore } from "../../src/runtime/auth/credential-store.js"
import type { AuthBrokerOptions } from "../../src/runtime/auth/auth-broker.js"
import {
  evaluateProviderModelBehavior,
  type VerifyProviderModelBehaviorInput
} from "../../src/runtime/certification/model-verifier.js"
import type { EvalTrace } from "../behavior-contract.js"

export const LiveEvalTarget = Schema.Struct({
  connection: ProviderConnection,
  modelId: ProviderModelId,
  accessCredentialEnv: Schema.String,
  refreshCredentialEnv: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number)
})
export type LiveEvalTarget = Schema.Schema.Type<typeof LiveEvalTarget>

export const LiveEvalMatrix = Schema.Array(LiveEvalTarget)
export type LiveEvalMatrix = Schema.Schema.Type<typeof LiveEvalMatrix>

export class LiveEvalError extends Data.TaggedError("LiveEvalError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LiveTargetResult {
  readonly certification: ModelCertification
  readonly traces: ReadonlyArray<EvalTrace>
}

const routeKey = (value: {
  readonly providerId: string
  readonly modelId: string
  readonly authKind: string
}): string => `${value.providerId}:${value.modelId}:${value.authKind}`

/**
 * Reviewed runs must evaluate exactly the checked-in release candidates. This
 * prevents a stale or extra model in the environment-owned credential matrix
 * from silently becoming release evidence.
 */
export const requireReleaseCandidateMatrix = (
  targets: LiveEvalMatrix,
  candidates: ReadonlyArray<ReleaseModelCandidate>
): Effect.Effect<void, LiveEvalError> => {
  const targetKeys = new Set(targets.map((target) => routeKey({
    providerId: target.connection.providerId,
    modelId: target.modelId,
    authKind: target.connection.authKind
  })))
  const candidateKeys = new Set(candidates.map(routeKey))
  const missing = [...candidateKeys].filter((key) => !targetKeys.has(key))
  const unexpected = [...targetKeys].filter((key) => !candidateKeys.has(key))
  return missing.length === 0 && unexpected.length === 0
    ? Effect.void
    : Effect.fail(new LiveEvalError({
        message: [
          missing.length === 0 ? null : `missing release candidates: ${missing.join(", ")}`,
          unexpected.length === 0 ? null : `unexpected live targets: ${unexpected.join(", ")}`
        ].filter((issue): issue is string => issue !== null).join("; ")
      }))
}

const requiredCredential = (
  name: string
): Effect.Effect<string, LiveEvalError> => {
  const value = process.env[name]
  return value
    ? Effect.succeed(value)
    : Effect.fail(new LiveEvalError({ message: `Credential environment variable ${name} is unavailable` }))
}

const optionalCredential = (
  name: string | null
): Effect.Effect<string | null, LiveEvalError> =>
  name === null ? Effect.succeed(null) : requiredCredential(name)

const makeCredentials = (
  target: LiveEvalTarget
): Effect.Effect<{
  readonly access: string
  readonly store: InMemoryProviderCredentialStore
}, LiveEvalError> =>
  Effect.gen(function* () {
    const access = yield* requiredCredential(target.accessCredentialEnv)
    const oauth = target.connection.authKind === "openai-codex-oauth"
    if (oauth && target.refreshCredentialEnv === null) {
      return yield* new LiveEvalError({
        message: "A Codex OAuth refresh credential environment name is required"
      })
    }
    const refresh = yield* optionalCredential(target.refreshCredentialEnv)
    if (oauth && target.expiresAt === null) {
      return yield* new LiveEvalError({ message: "Codex OAuth expiry is required" })
    }
    const store = new InMemoryProviderCredentialStore()
    yield* store.write({
      connectionId: target.connection.id,
      authKind: target.connection.authKind,
      access,
      refresh,
      expiresAt: target.expiresAt
    }).pipe(
      Effect.mapError((cause) => new LiveEvalError({
        message: "Failed to stage the connection-pinned credential",
        cause
      }))
    )
    return { access, store }
  })

export const runLiveTarget = (
  target: LiveEvalTarget,
  provenance: ModelCertification["provenance"],
  options: {
    readonly probe?: AuthBrokerOptions["probe"]
    readonly runScenario?: (
      target: LiveEvalTarget,
      credentials: InMemoryProviderCredentialStore,
      scenarioId: string
    ) => Effect.Effect<EvalTrace>
  } = {}
): Effect.Effect<LiveTargetResult, LiveEvalError> =>
  Effect.gen(function* () {
    const credentials = yield* makeCredentials(target)
    const requestedRunner = options.runScenario
    const runScenario: VerifyProviderModelBehaviorInput["runScenario"] =
      requestedRunner === undefined
        ? undefined
        : (input) =>
            Effect.runPromise(requestedRunner({
              ...target,
              connection: input.connection
            }, credentials.store, input.scenarioId))
    return yield* evaluateProviderModelBehavior({
      connection: target.connection,
      access: credentials.access,
      credentials: credentials.store,
      modelId: target.modelId,
      provenance,
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(runScenario === undefined ? {} : { runScenario })
    }).pipe(
      Effect.mapError((cause) => new LiveEvalError({
        message: cause.message,
        cause
      }))
    )
  })

export const runLiveMatrix = (
  targets: LiveEvalMatrix,
  provenance: ModelCertification["provenance"]
): Effect.Effect<ReadonlyArray<LiveTargetResult>, LiveEvalError> =>
  Effect.forEach(targets, (target) => runLiveTarget(target, provenance), {
    concurrency: 1
  })

import {
  OffloadAdmissionError,
  OffloadAdmissionRequest,
  OffloadAdmissionResponse,
  type OffloadAdmissionRequest as OffloadAdmissionRequestValue,
  type OffloadAdmissionResponse as OffloadAdmissionResponseValue
} from "@jingler/core"
import { Context, Effect, Either, Layer, Schema } from "effect"
import { Hono } from "hono"
import { getAuth } from "./auth.js"
import { upsertAuthStateCapability } from "./auth-state-client.js"
import { env } from "./env.js"
import { managedGitHubCapabilityForUser } from "./github-routes.js"
import { decodeBoundedJson } from "./request-decoding.js"

interface RuntimeGrantInput {
  readonly subject: string
  readonly request: OffloadAdmissionRequestValue
}

export interface ManagedOffloadPortShape {
  readonly enabled: boolean
  readonly authenticate: (
    headers: Headers
  ) => Effect.Effect<string | null, OffloadAdmissionError>
  readonly authorizeRepository: (
    subject: string,
    repositorySlug: string
  ) => Effect.Effect<void, OffloadAdmissionError>
  readonly issueRuntimeGrant: (
    input: RuntimeGrantInput
  ) => Effect.Effect<OffloadAdmissionResponseValue, OffloadAdmissionError>
}

export class ManagedOffloadPorts extends Context.Tag("@jingler/ManagedOffloadPorts")<
  ManagedOffloadPorts,
  ManagedOffloadPortShape
>() {}

const admissionFailure = (
  reason: OffloadAdmissionError["reason"],
  message: string
): OffloadAdmissionError => new OffloadAdmissionError({ reason, message })

/** Effect-owned admission policy; Hono is only an encoder around this service. */
export class ManagedOffloadAdmission extends Effect.Service<ManagedOffloadAdmission>()(
  "@jingler/ManagedOffloadAdmission",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const ports = yield* ManagedOffloadPorts
      const admit = (
        headers: Headers,
        body: unknown
      ): Effect.Effect<OffloadAdmissionResponseValue, OffloadAdmissionError> =>
        Effect.gen(function* () {
          if (!ports.enabled) {
            return yield* Effect.fail(
              admissionFailure("disabled", "Offload Compute is disabled")
            )
          }
          const subject = yield* ports.authenticate(headers)
          if (subject === null) {
            return yield* Effect.fail(
              admissionFailure("authentication", "Authentication required")
            )
          }
          const request = yield* Schema.decodeUnknown(OffloadAdmissionRequest)(body, {
            onExcessProperty: "error"
          }).pipe(
            Effect.mapError(() =>
              admissionFailure("invalid-input", "Invalid offload admission request")
            )
          )
          yield* ports.authorizeRepository(subject, request.repositorySlug)
          return yield* ports.issueRuntimeGrant({ subject, request })
        })
      return { admit }
    })
  }
) {}

const runtimeError = async (response: Response): Promise<OffloadAdmissionError> => {
  const body: unknown = await response.json().catch(() => null)
  const message =
    typeof body === "object" && body !== null &&
    "error" in body && typeof body.error === "string"
      ? body.error
      : "Managed runtime unavailable"
  return admissionFailure(
    response.status === 429
      ? "concurrency"
      : response.status === 401 || response.status === 403
        ? "authorization"
        : "unavailable",
    message
  )
}

export const ManagedOffloadPortsLive = Layer.succeed(ManagedOffloadPorts, {
  enabled: env.managedEnvironmentsEnabled && env.offloadComputeEnabled,
  authenticate: (headers) =>
    Effect.tryPromise({
      try: () => getAuth().api.getSession({ headers }),
      catch: () => admissionFailure("unavailable", "Authentication service unavailable")
    }).pipe(Effect.map((session) => session?.user?.id ?? null)),
  authorizeRepository: (subject, _repositorySlug) =>
    Effect.tryPromise({
      try: async () => {
        const capability = await managedGitHubCapabilityForUser(subject)
        if (capability === null) throw admissionFailure(
          "authorization",
          "Connect GitHub before using Offload Compute"
        )
        await upsertAuthStateCapability(
          {
            enabled: true,
            url: env.authStateUrl,
            serviceSecret: env.authStateServiceSecret
          },
          {
            userId: subject,
            provider: "github",
            ...capability
          }
        )
      },
      catch: (cause) =>
        cause instanceof OffloadAdmissionError
          ? cause
          : admissionFailure("unavailable", "GitHub authorization sync unavailable")
    }),
  issueRuntimeGrant: ({ subject, request }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(
          new URL("/v1/offload/grants", env.managedRuntimeUrl),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              subject,
              ...request
            })
          }
        )
        if (!response.ok) throw await runtimeError(response)
        return Schema.decodeUnknownSync(OffloadAdmissionResponse)(await response.json(), {
          onExcessProperty: "error"
        })
      },
      catch: (cause) =>
        cause instanceof OffloadAdmissionError
          ? cause
          : admissionFailure("unavailable", "Managed runtime unavailable")
    })
})

const errorStatus = (error: OffloadAdmissionError): number => {
  switch (error.reason) {
    case "authentication": return 401
    case "disabled": return 404
    case "invalid-input": return 400
    case "authorization": return 403
    case "concurrency": return 429
    case "unavailable": return 503
  }
}

const noStoreHeaders = { "cache-control": "no-store" } as const
const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders })

export const createManagedOffloadRoutes = (
  ports: Layer.Layer<ManagedOffloadPorts> = ManagedOffloadPortsLive
): Hono => {
  const routes = new Hono()
  const service = ManagedOffloadAdmission.Default.pipe(Layer.provide(ports))
  routes.post("/jobs", async (context) => {
    const body = await decodeBoundedJson(context.req.raw, Schema.Unknown)
    if (body === null) {
      return json({ error: "Invalid offload admission request" }, 400)
    }
    const admitted = await Effect.runPromise(
      ManagedOffloadAdmission.admit(context.req.raw.headers, body).pipe(
        Effect.provide(service),
        Effect.either
      )
    )
    return Either.isRight(admitted)
      ? json(admitted.right)
      : json({ error: admitted.left.message }, errorStatus(admitted.left))
  })
  return routes
}

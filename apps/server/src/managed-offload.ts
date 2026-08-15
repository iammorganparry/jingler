import {
  OffloadAdmissionError,
  OffloadAdmissionRequest,
  OffloadAdmissionResponse,
  OffloadPrimeRequest,
  OffloadSandboxDestroyRequest,
  type OffloadAdmissionRequest as OffloadAdmissionRequestValue,
  type OffloadAdmissionResponse as OffloadAdmissionResponseValue,
  type OffloadPrimeRequest as OffloadPrimeRequestValue,
  type OffloadSandboxDestroyRequest as OffloadSandboxDestroyRequestValue
} from "@jingler/core"
import { Context, Effect, Either, Layer, Schema } from "effect"
import { Hono } from "hono"
import { getAuth } from "./auth.js"
import { upsertAuthStateCapability } from "./auth-state-client.js"
import { env } from "./env.js"
import { managedGitHubCapabilityForRepository } from "./github-routes.js"
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
  readonly primeRuntime: (
    subject: string,
    request: OffloadPrimeRequestValue
  ) => Effect.Effect<void, OffloadAdmissionError>
  readonly destroySandbox: (
    subject: string,
    request: OffloadSandboxDestroyRequestValue
  ) => Effect.Effect<void, OffloadAdmissionError>
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
      const authenticated = (
        headers: Headers
      ): Effect.Effect<string, OffloadAdmissionError> =>
        ports.authenticate(headers).pipe(
          Effect.flatMap((subject) =>
            subject === null
              ? Effect.fail(admissionFailure("authentication", "Authentication required"))
              : Effect.succeed(subject)
          )
        )
      const prime = (
        headers: Headers,
        body: unknown
      ): Effect.Effect<void, OffloadAdmissionError> =>
        Effect.gen(function* () {
          if (!ports.enabled) {
            return yield* Effect.fail(admissionFailure("disabled", "Offload Compute is disabled"))
          }
          const subject = yield* authenticated(headers)
          const request = yield* Schema.decodeUnknown(OffloadPrimeRequest)(body, {
            onExcessProperty: "error"
          }).pipe(
            Effect.mapError(() => admissionFailure("invalid-input", "Invalid offload prime request"))
          )
          yield* ports.authorizeRepository(subject, request.repositorySlug)
          yield* ports.primeRuntime(subject, request)
        })
      const destroy = (
        headers: Headers,
        body: unknown
      ): Effect.Effect<void, OffloadAdmissionError> =>
        Effect.gen(function* () {
          const subject = yield* authenticated(headers)
          const request = yield* Schema.decodeUnknown(OffloadSandboxDestroyRequest)(body, {
            onExcessProperty: "error"
          }).pipe(
            Effect.mapError(() => admissionFailure("invalid-input", "Invalid sandbox cleanup request"))
          )
          yield* ports.destroySandbox(subject, request)
        })
      return { admit, prime, destroy }
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

const postRuntimeOperation = (
  path: string,
  body: unknown
): Effect.Effect<void, OffloadAdmissionError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL(path, env.managedRuntimeUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      })
      if (!response.ok) throw await runtimeError(response)
    },
    catch: (cause) =>
      cause instanceof OffloadAdmissionError
        ? cause
        : admissionFailure("unavailable", "Managed runtime unavailable")
  })

export const ManagedOffloadPortsLive = Layer.succeed(ManagedOffloadPorts, {
  enabled: env.managedEnvironmentsEnabled && env.offloadComputeEnabled,
  authenticate: (headers) =>
    Effect.tryPromise({
      try: () => getAuth().api.getSession({ headers }),
      catch: () => admissionFailure("unavailable", "Authentication service unavailable")
    }).pipe(Effect.map((session) => session?.user?.id ?? null)),
  authorizeRepository: (subject, repositorySlug) =>
    Effect.tryPromise({
      try: async () => {
        const capability = await managedGitHubCapabilityForRepository(subject, repositorySlug)
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
    }),
  primeRuntime: (subject, request) =>
    postRuntimeOperation("/v1/offload/prime", { subject, ...request }),
  destroySandbox: (subject, request) =>
    postRuntimeOperation("/v1/offload/sandboxes/destroy", { subject, ...request })
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
  routes.post("/prime", async (context) => {
    const body = await decodeBoundedJson(context.req.raw, Schema.Unknown)
    if (body === null) return json({ error: "Invalid offload prime request" }, 400)
    const primed = await Effect.runPromise(
      ManagedOffloadAdmission.prime(context.req.raw.headers, body).pipe(
        Effect.provide(service),
        Effect.either
      )
    )
    return Either.isRight(primed)
      ? json({ accepted: true }, 202)
      : json({ error: primed.left.message }, errorStatus(primed.left))
  })
  routes.post("/sandboxes/destroy", async (context) => {
    const body = await decodeBoundedJson(context.req.raw, Schema.Unknown)
    if (body === null) return json({ error: "Invalid sandbox cleanup request" }, 400)
    const destroyed = await Effect.runPromise(
      ManagedOffloadAdmission.destroy(context.req.raw.headers, body).pipe(
        Effect.provide(service),
        Effect.either
      )
    )
    return Either.isRight(destroyed)
      ? json({ destroyed: true })
      : json({ error: destroyed.left.message }, errorStatus(destroyed.left))
  })
  return routes
}

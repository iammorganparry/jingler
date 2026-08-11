import { randomBytes } from "node:crypto"
import { managedRuntimeActionForOperation } from "@jingler/core"
import type {
  ManagedEnvironment,
  ManagedEnvironmentGrantResponse,
  ManagedRuntimeAction,
  RemoteSessionCommand,
  RemoteSessionEvent
} from "@jingler/core"
import { RemoteSessionEvent as RemoteSessionEventSchema } from "@jingler/core"
import { Effect, Queue, Schema, Stream } from "effect"
import WebSocket from "ws"
import type {
  RemoteEnvironmentTransport,
  RemoteSessionResource
} from "./remote-environment-transport.js"
import { RemoteSessionError } from "./remote-session.js"

type Output =
  | { readonly _tag: "event"; readonly event: RemoteSessionEvent }
  | { readonly _tag: "error"; readonly error: RemoteSessionError }

export interface ManagedSessionTransportDependencies {
  readonly environment: (
    environmentId: string
  ) => Effect.Effect<ManagedEnvironment, RemoteSessionError>
  readonly grant: (
    environment: ManagedEnvironment,
    sessionId: string,
    usageIntervalId: string,
    actions: ReadonlyArray<ManagedRuntimeAction>
  ) => Effect.Effect<ManagedEnvironmentGrantResponse, RemoteSessionError>
  readonly fetch?: typeof fetch
}

const eventsUrl = (
  grant: ManagedEnvironmentGrantResponse,
  sessionId: string,
  commandId: string
): string => {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    grant.runtimeUrl
  )
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("commandId", commandId)
  url.searchParams.set("after", "-1")
  return url.toString()
}

const commandsUrl = (
  grant: ManagedEnvironmentGrantResponse,
  sessionId: string
): string =>
  new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
    grant.runtimeUrl
  ).toString()

export const makeManagedSessionTransport = (
  dependencies: ManagedSessionTransportDependencies
): RemoteEnvironmentTransport<RemoteSessionError> => ({
  execute: (session, operation, payload, suppliedCommandId) =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        if (!session.environmentId) {
          return yield* Effect.fail(
            new RemoteSessionError({ message: "Managed session has no environment identity." })
          )
        }
        const command: RemoteSessionCommand = {
          version: 1,
          commandId: suppliedCommandId ?? randomBytes(18).toString("base64url"),
          sessionId: session.id,
          operation,
          payload
        }
        const environment = yield* dependencies.environment(session.environmentId)
        const grant = yield* dependencies.grant(
          environment,
          session.id,
          command.commandId,
          [managedRuntimeActionForOperation(operation)]
        )
        const output = yield* Queue.unbounded<Output>()
        let expectedSequence = 0
        let terminal = false

        const socket = yield* Effect.acquireRelease(
          Effect.async<WebSocket, RemoteSessionError>((resume) => {
            const candidate = new WebSocket(
              eventsUrl(grant, session.id, command.commandId),
              { headers: { authorization: `Bearer ${grant.grant}` } }
            )
            const failOpen = (cause: unknown) => {
              candidate.close()
              resume(
                Effect.fail(
                  new RemoteSessionError({
                    message: "Could not observe the managed session.",
                    cause
                  })
                )
              )
            }
            candidate.once("error", failOpen)
            candidate.once("open", () => {
              candidate.off("error", failOpen)
              resume(Effect.succeed(candidate))
            })
          }),
          (socket) => Effect.sync(() => socket.close())
        )

        socket.on("message", (raw) => {
          try {
            const event = Schema.decodeUnknownSync(RemoteSessionEventSchema)(
              JSON.parse(raw.toString("utf8")),
              { onExcessProperty: "error" }
            )
            if (
              event.sessionId !== session.id ||
              event.commandId !== command.commandId ||
              event.eventSequence !== expectedSequence
            ) {
              throw new Error(
                `Managed event sequence mismatch: expected ${expectedSequence}, received ${event.eventSequence}.`
              )
            }
            expectedSequence += 1
            terminal = event.kind === "complete" || event.kind === "failed"
            Effect.runFork(Queue.offer(output, { _tag: "event", event }))
          } catch (cause) {
            Effect.runFork(
              Queue.offer(
                output,
                {
                  _tag: "error",
                  error: new RemoteSessionError({
                    message: "Managed runtime returned an invalid session event.",
                    cause
                  })
                }
              )
            )
          }
        })
        socket.on("error", (cause) => {
          if (terminal) return
          Effect.runFork(
            Queue.offer(output, {
              _tag: "error",
              error: new RemoteSessionError({
                message: "Managed session event stream failed.",
                cause
              })
            })
          )
        })
        socket.on("close", () => {
          if (!terminal) {
            Effect.runFork(
              Queue.offer(output, {
                _tag: "error",
                error: new RemoteSessionError({
                  message: "Managed session event stream closed before completion."
                })
              })
            )
          }
        })

        const response = yield* Effect.tryPromise({
          try: () => (dependencies.fetch ?? fetch)(commandsUrl(grant, session.id), {
            method: "POST",
            headers: {
              authorization: `Bearer ${grant.grant}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(command)
          }),
          catch: (cause) =>
            new RemoteSessionError({
              message: "Could not submit the managed session command.",
              cause
            })
        })
        if (!response.ok) {
          return yield* Effect.fail(
            new RemoteSessionError({
              message:
                response.status === 401 || response.status === 403
                  ? "Managed session authorization expired. Reconnect the environment."
                  : response.status === 409
                    ? "Managed session state changed. Retry the operation."
                    : response.status === 429
                      ? "Managed session capacity or budget limit was reached."
                      : "Managed session command was rejected."
            })
          )
        }

        return Stream.fromQueue(output).pipe(
          Stream.takeUntil(
            (item) =>
              item._tag === "event" &&
              (item.event.kind === "complete" || item.event.kind === "failed")
          ),
          Stream.mapEffect((item) =>
            item._tag === "event" ? Effect.succeed(item.event) : Effect.fail(item.error)
          )
        )
      })
    )
})

export const managedEnvironmentFromSession = (
  session: RemoteSessionResource,
  value: ManagedEnvironment
): ManagedEnvironment => {
  if (session.environmentId !== value.id) {
    throw new RemoteSessionError({ message: "Managed environment scope mismatch." })
  }
  return value
}

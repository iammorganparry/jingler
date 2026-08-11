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
  commandId: string,
  after: number
): string => {
  const url = new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    grant.runtimeUrl
  )
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("commandId", commandId)
  url.searchParams.set("after", String(after))
  return url.toString()
}

const MAX_OBSERVER_RECONNECTS = 5

const openObserver = (input: {
  readonly grant: ManagedEnvironmentGrantResponse
  readonly sessionId: string
  readonly commandId: string
  readonly after: number
  readonly onMessage: (raw: WebSocket.RawData) => void
  readonly onDisconnect: (cause?: unknown) => void
}): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const candidate = new WebSocket(
      eventsUrl(input.grant, input.sessionId, input.commandId, input.after),
      { headers: { authorization: `Bearer ${input.grant.grant}` } }
    )
    let opened = false
    let disconnectCause: unknown
    candidate.on("message", input.onMessage)
    candidate.once("open", () => {
      opened = true
      resolve(candidate)
    })
    candidate.once("error", (cause) => {
      if (!opened) {
        reject(cause)
        return
      }
      disconnectCause = cause
      candidate.close()
    })
    candidate.once("close", () => {
      if (opened) input.onDisconnect(disconnectCause)
    })
  })

const commandsUrl = (
  grant: ManagedEnvironmentGrantResponse,
  sessionId: string
): string =>
  new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
    grant.runtimeUrl
  ).toString()

interface ObserverIdentity {
  readonly environmentId: string
  readonly sessionId: string
  readonly commandId: string
  readonly action: ManagedRuntimeAction
}

class ManagedSessionObserver {
  readonly #dependencies: ManagedSessionTransportDependencies
  readonly #identity: ObserverIdentity
  readonly #output: Queue.Queue<Output>
  readonly #sockets = new Set<WebSocket>()
  #expectedSequence = 0
  #terminal = false
  #disposed = false
  #reconnecting = false
  #reconnects = 0

  constructor(
    dependencies: ManagedSessionTransportDependencies,
    identity: ObserverIdentity,
    output: Queue.Queue<Output>
  ) {
    this.#dependencies = dependencies
    this.#identity = identity
    this.#output = output
  }

  async start(grant: ManagedEnvironmentGrantResponse): Promise<void> {
    this.#sockets.add(await this.#connect(grant))
  }

  close(): void {
    this.#disposed = true
    for (const socket of this.#sockets) socket.close()
  }

  #connect(grant: ManagedEnvironmentGrantResponse): Promise<WebSocket> {
    return openObserver({
      grant,
      sessionId: this.#identity.sessionId,
      commandId: this.#identity.commandId,
      after: this.#expectedSequence - 1,
      onMessage: (raw) => this.#onMessage(raw),
      onDisconnect: (cause) => this.#reconnect(cause)
    })
  }

  #onMessage(raw: WebSocket.RawData): void {
    try {
      const event = Schema.decodeUnknownSync(RemoteSessionEventSchema)(
        JSON.parse(raw.toString("utf8")),
        { onExcessProperty: "error" }
      )
      if (
        event.sessionId !== this.#identity.sessionId ||
        event.commandId !== this.#identity.commandId ||
        event.eventSequence !== this.#expectedSequence
      ) {
        throw new Error(
          `Managed event sequence mismatch: expected ${this.#expectedSequence}, received ${event.eventSequence}.`
        )
      }
      this.#expectedSequence += 1
      this.#terminal = event.kind === "complete" || event.kind === "failed"
      Effect.runFork(Queue.offer(this.#output, { _tag: "event", event }))
    } catch (cause) {
      this.#fail("Managed runtime returned an invalid session event.", cause)
    }
  }

  #reconnect(cause?: unknown): void {
    if (this.#terminal || this.#disposed || this.#reconnecting) return
    if (this.#reconnects >= MAX_OBSERVER_RECONNECTS) {
      this.#fail("Managed session event stream closed before completion.", cause)
      return
    }
    this.#reconnecting = true
    this.#reconnects += 1
    const delayMs = Math.min(1_000, 50 * 2 ** (this.#reconnects - 1))
    Effect.runPromise(this.#reconnectEffect(delayMs)).then((socket) => {
      this.#reconnecting = false
      if (this.#disposed || this.#terminal) socket.close()
      else this.#sockets.add(socket)
    }).catch((error) => {
      this.#reconnecting = false
      this.#reconnect(error)
    })
  }

  #reconnectEffect(delayMs: number): Effect.Effect<WebSocket, RemoteSessionError> {
    return Effect.sleep(delayMs).pipe(
      Effect.zipRight(this.#dependencies.environment(this.#identity.environmentId)),
      Effect.flatMap((environment) =>
        this.#dependencies.grant(
          environment,
          this.#identity.sessionId,
          this.#identity.commandId,
          [this.#identity.action]
        )
      ),
      Effect.flatMap((grant) => Effect.tryPromise({
        try: () => this.#connect(grant),
        catch: (error) => new RemoteSessionError({
          message: "Could not reconnect the managed session event stream.",
          cause: error
        })
      }))
    )
  }

  #fail(message: string, cause?: unknown): void {
    if (this.#terminal || this.#disposed) return
    Effect.runFork(Queue.offer(this.#output, {
      _tag: "error",
      error: new RemoteSessionError({ message, cause })
    }))
  }
}

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
        const environmentId = session.environmentId
        const command: RemoteSessionCommand = {
          version: 1,
          commandId: suppliedCommandId ?? randomBytes(18).toString("base64url"),
          sessionId: session.id,
          operation,
          payload
        }
        const environment = yield* dependencies.environment(environmentId)
        const grant = yield* dependencies.grant(
          environment,
          session.id,
          command.commandId,
          [managedRuntimeActionForOperation(operation)]
        )
        const output = yield* Queue.unbounded<Output>()
        const observer = new ManagedSessionObserver(
          dependencies,
          {
            environmentId,
            sessionId: session.id,
            commandId: command.commandId,
            action: managedRuntimeActionForOperation(operation)
          },
          output
        )
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              await observer.start(grant)
              return observer
            },
            catch: (error) => new RemoteSessionError({
              message: "Could not observe the managed session.",
              cause: error
            })
          }),
          (activeObserver) => Effect.sync(() => activeObserver.close())
        )

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

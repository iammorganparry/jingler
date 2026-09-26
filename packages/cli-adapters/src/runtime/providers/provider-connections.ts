import {
  type ConnectClaudeTokenInput,
  type ModelCertification,
  ProviderConnection,
  type ProviderCatalog,
  ProviderConnectionId,
  type ProviderLoginEvent,
  type SetProviderApiKeyInput,
  type StartCodexLoginInput,
  type VerifyProviderModelInput
} from "@jingler/core"
import { Context, Data, Effect, Exit, PubSub, Schema, Stream } from "effect"
import type {
  AuthBrokerShape,
  OAuthInteraction
} from "../auth/auth-broker.js"
import { AtomicJsonFile } from "../persistence/atomic-json-file.js"
import type { ProviderCatalogShape } from "./provider-catalog.js"

export class ProviderConnectionsError extends Data.TaggedError(
  "ProviderConnectionsError"
)<{ readonly message: string; readonly cause?: unknown }> {}

export interface ProviderConnectionsOptions {
  readonly file: string
  readonly broker: AuthBrokerShape
  readonly catalog: ProviderCatalogShape
  readonly codexInteraction: (
    method: StartCodexLoginInput["method"]
  ) => Pick<OAuthInteraction, "prompt" | "notify">
  readonly verifyModel: (
    input: VerifyProviderModelInput
  ) => Effect.Effect<ModelCertification, ProviderConnectionsError>
}

export interface ProviderConnectionsShape {
  readonly loginEvents: Stream.Stream<ProviderLoginEvent>
  readonly list: Effect.Effect<ProviderCatalog, ProviderConnectionsError>
  readonly refreshCatalog: Effect.Effect<ProviderCatalog, ProviderConnectionsError>
  readonly status: Effect.Effect<ReadonlyArray<ProviderConnection>, ProviderConnectionsError>
  /** Main-process-only credential resolution for an explicitly selected route. */
  readonly resolveCredential: (
    id: ProviderConnectionId
  ) => Effect.Effect<
    {
      readonly connection: ProviderConnection
      readonly access: string
      readonly expiresAt: number | null
      readonly accountId: string | null
    },
    ProviderConnectionsError
  >
  readonly connectClaudeToken: (
    input: ConnectClaudeTokenInput
  ) => Effect.Effect<ProviderConnection, ProviderConnectionsError>
  readonly startCodexLogin: (
    input: StartCodexLoginInput
  ) => Effect.Effect<ProviderConnection, ProviderConnectionsError>
  readonly cancelLogin: (id: ProviderConnectionId) => Effect.Effect<void>
  readonly setApiKey: (
    input: SetProviderApiKeyInput
  ) => Effect.Effect<ProviderConnection, ProviderConnectionsError>
  readonly refresh: (
    id: ProviderConnectionId
  ) => Effect.Effect<ProviderConnection, ProviderConnectionsError>
  readonly logout: (
    id: ProviderConnectionId
  ) => Effect.Effect<void, ProviderConnectionsError>
  /** Fully removes the connection: broker state, credential, and persistence. */
  readonly remove: (
    id: ProviderConnectionId
  ) => Effect.Effect<void, ProviderConnectionsError>
  readonly verifyModel: ProviderConnectionsOptions["verifyModel"]
}

export class ProviderConnections extends Context.Tag(
  "@jingler/ProviderConnections"
)<ProviderConnections, ProviderConnectionsShape>() {}

const Document = Schema.Array(ProviderConnection)
const decode = (raw: string) =>
  Schema.decodeUnknownSync(Document)(JSON.parse(raw))
const connectionDocument = (file: string) =>
  new AtomicJsonFile({ file, decode, fallback: () => [] })
const serviceError = (message: string) => (cause: unknown) =>
  new ProviderConnectionsError({ message, cause })
const brokerCall = <A>(operation: Effect.Effect<A, { readonly message: string }>) =>
  operation.pipe(
    Effect.mapError((cause) =>
      new ProviderConnectionsError({ message: cause.message, cause })
    )
  )
const persistConnection =
  (document: ReturnType<typeof connectionDocument>) =>
  (connection: ProviderConnection) =>
    Effect.tryPromise({
      try: () =>
        document.update((current) => [
          ...current.filter((item) => item.id !== connection.id),
          connection
        ]),
      catch: serviceError("Failed to persist provider connection")
    }).pipe(Effect.as(connection))
const removeConnection = (
  document: ReturnType<typeof connectionDocument>,
  id: ProviderConnectionId
) =>
  Effect.tryPromise({
    try: () =>
      document.update((current) =>
        current.filter((item) => item.id !== id)
      ),
    catch: serviceError("Failed to remove provider connection")
  })

export const makeProviderConnections = (
  options: ProviderConnectionsOptions
): Effect.Effect<ProviderConnectionsShape, ProviderConnectionsError> =>
  Effect.gen(function* () {
    const loginEvents = yield* PubSub.unbounded<ProviderLoginEvent>()
    const document = connectionDocument(options.file)
    const restored = yield* Effect.tryPromise({
      try: () => document.read(),
      catch: serviceError("Failed to read provider connections")
    })
    yield* options.broker.restore(restored)

    const persist = persistConnection(document)
    const setupLock = yield* Effect.makeSemaphore(1)
    const persistSetup = <E extends { readonly message: string }>(
      setup: Effect.Effect<ProviderConnection, E>
    ) => setupLock.withPermits(1)(
      Effect.acquireUseRelease(
        brokerCall(setup),
        persist,
        (connection, exit) => Exit.isSuccess(exit)
          ? Effect.void
          : brokerCall(options.broker.delete(connection.id)).pipe(Effect.orDie)
      )
    )
    const refreshCatalog = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.tap(() =>
          options.catalog.refresh.pipe(
            Effect.mapError(serviceError("Failed to refresh provider catalog"))
          )
        )
      )
    return {
      loginEvents: Stream.fromPubSub(loginEvents),
      list: options.catalog.list.pipe(
        Effect.mapError(serviceError("Failed to list providers"))
      ),
      refreshCatalog: options.catalog.refresh.pipe(
        Effect.mapError(serviceError("Failed to refresh providers"))
      ),
      status: options.broker.list,
      resolveCredential: (id) => brokerCall(options.broker.resolve(id)),
      connectClaudeToken: (input) =>
        persistSetup(options.broker.connectClaudeToken(input)).pipe(
          refreshCatalog
        ),
      startCodexLogin: (input) =>
        Effect.gen(function* () {
          const connectionId = yield* Schema.decodeUnknown(ProviderConnectionId)(input.id).pipe(
            Effect.mapError(serviceError("Invalid provider connection id"))
          )
          const interaction = options.codexInteraction(input.method)
          return yield* persistSetup(
            options.broker.startCodexLogin({
              id: input.id,
              targetId: input.targetId,
              prompt: interaction.prompt,
              notify: (event) => {
                interaction.notify(event)
                const normalized: ProviderLoginEvent = event.type === "auth_url"
                  ? {
                      type: "auth-url",
                      connectionId,
                      url: event.url,
                      instructions: event.instructions ?? null
                    }
                  : event.type === "device_code"
                    ? {
                        type: "device-code",
                        connectionId,
                        userCode: event.userCode,
                        verificationUri: event.verificationUri,
                        expiresInSeconds: event.expiresInSeconds ?? null
                      }
                    : {
                        type: event.type,
                        connectionId,
                        message: event.message
                      }
                Effect.runFork(PubSub.publish(loginEvents, normalized))
              }
            })
          ).pipe(refreshCatalog)
        }),
      cancelLogin: (id) => options.broker.cancelLogin(id),
      setApiKey: (input) =>
        persistSetup(
          options.broker.setApiKey({
            id: input.id,
            provider: input.providerId,
            apiKey: input.apiKey,
            targetId: input.targetId
          })
        ).pipe(refreshCatalog),
      refresh: (id) =>
        brokerCall(options.broker.refresh(id)).pipe(
          Effect.flatMap(persist),
          refreshCatalog
        ),
      logout: (id) =>
        brokerCall(options.broker.logout(id)).pipe(
          Effect.zipRight(removeConnection(document, id)),
          refreshCatalog
        ),
      remove: (id) =>
        brokerCall(options.broker.delete(id)).pipe(
          Effect.zipRight(removeConnection(document, id)),
          refreshCatalog
        ),
      verifyModel: (input) => options.verifyModel(input).pipe(refreshCatalog)
    }
  })

import {
  type ConnectClaudeTokenInput,
  type ModelCertification,
  ProviderConnection,
  type ProviderCatalog,
  type ProviderConnectionId,
  type SetProviderApiKeyInput,
  type StartCodexLoginInput,
  type VerifyProviderModelInput
} from "@jingler/core"
import { Context, Data, Effect, Schema } from "effect"
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
  readonly list: Effect.Effect<ProviderCatalog, ProviderConnectionsError>
  readonly status: Effect.Effect<ReadonlyArray<ProviderConnection>, ProviderConnectionsError>
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
    Effect.mapError(serviceError("Provider authentication failed"))
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
    const document = connectionDocument(options.file)
    const restored = yield* Effect.tryPromise({
      try: () => document.read(),
      catch: serviceError("Failed to read provider connections")
    })
    yield* options.broker.restore(restored)

    const persist = persistConnection(document)
    return {
      list: options.catalog.list.pipe(
        Effect.mapError(serviceError("Failed to list providers"))
      ),
      status: options.broker.list,
      connectClaudeToken: (input) =>
        brokerCall(options.broker.connectClaudeToken(input)).pipe(
          Effect.flatMap(persist)
        ),
      startCodexLogin: (input) =>
        brokerCall(
          options.broker.startCodexLogin({
            id: input.id,
            targetId: input.targetId,
            ...options.codexInteraction(input.method)
          })
        ).pipe(Effect.flatMap(persist)),
      cancelLogin: (id) => options.broker.cancelLogin(id),
      setApiKey: (input) =>
        brokerCall(
          options.broker.setApiKey({
            id: input.id,
            provider: input.providerId,
            apiKey: input.apiKey,
            targetId: input.targetId
          })
        ).pipe(Effect.flatMap(persist)),
      refresh: (id) =>
        brokerCall(options.broker.refresh(id)).pipe(Effect.flatMap(persist)),
      logout: (id) =>
        brokerCall(options.broker.logout(id)).pipe(
          Effect.zipRight(removeConnection(document, id))
        ),
      verifyModel: options.verifyModel
    }
  })

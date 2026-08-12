import {
  certificationKey,
  isCurrentCertification,
  type ModelCertification,
  type ProviderCatalog,
  type ProviderCatalogModel,
  type ProviderConnection,
  type ProviderId,
  type ProviderModelCapabilities,
  type ProviderModelId
} from "@jingler/core"
import { Context, Data, Duration, Effect, Ref } from "effect"
import type { ModelCertificationStore } from "../certification/model-certification-store.js"

export class ProviderCatalogError extends Data.TaggedError("ProviderCatalogError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface DiscoveredProviderModel {
  readonly providerId: ProviderId
  readonly id: ProviderModelId
  readonly label: string
  readonly capabilities: ProviderModelCapabilities
}

export interface ProviderCatalogOptions {
  /** The pi ModelRuntime adapter is supplied here; catalog policy never probes PATH. */
  readonly discover: (
    connection: ProviderConnection,
    signal: AbortSignal
  ) => Effect.Effect<ReadonlyArray<DiscoveredProviderModel>, ProviderCatalogError>
  readonly connections: Effect.Effect<ReadonlyArray<ProviderConnection>>
  readonly certifications: ModelCertificationStore
  readonly targetAvailable: (
    connection: ProviderConnection,
    model: DiscoveredProviderModel
  ) => boolean
  readonly timeoutMs?: number
  readonly now?: () => number
}

const matchingCertification = (
  certifications: ReadonlyArray<ModelCertification>,
  connection: ProviderConnection,
  model: DiscoveredProviderModel
): ModelCertification | null => {
  const matching = certifications.filter(
    (item) =>
      item.providerId === model.providerId &&
      item.modelId === model.id &&
      item.authRoute.kind === connection.authKind
  )
  return matching.find((item) => isCurrentCertification(item)) ?? matching.reduce<ModelCertification | null>(
    (latest, item) =>
      latest === null || item.certifiedAt > latest.certifiedAt ? item : latest,
    null
  )
}

const decorate = (
  model: DiscoveredProviderModel,
  connection: ProviderConnection,
  certifications: ReadonlyArray<ModelCertification>,
  targetAvailable: ProviderCatalogOptions["targetAvailable"]
): ProviderCatalogModel => {
  const certification = matchingCertification(certifications, connection, model)
  const current = certification !== null && isCurrentCertification(certification)
  const available = targetAvailable(connection, model)
  const authenticated = connection.status === "authenticated"
  const verification = !authenticated
    ? "connection-unavailable"
    : !available
      ? "target-unavailable"
      : current
        ? "certified"
        : certification === null
          ? "unverified"
          : "stale"

  return {
    ...model,
    verification,
    selectable: authenticated && available && current,
    certificationKey: current ? certificationKey(certification) : null
  }
}

export interface ProviderCatalogShape {
  readonly list: Effect.Effect<ProviderCatalog, ProviderCatalogError>
  readonly refresh: Effect.Effect<ProviderCatalog, ProviderCatalogError>
  readonly selectable: Effect.Effect<
    ReadonlyArray<ProviderCatalogModel>,
    ProviderCatalogError
  >
}

export class ProviderCatalogService extends Context.Tag(
  "@jingler/ProviderCatalogService"
)<ProviderCatalogService, ProviderCatalogShape>() {}

const loadCatalog = (
  options: ProviderCatalogOptions
): Effect.Effect<ProviderCatalog, ProviderCatalogError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.gen(function* () {
        const certifications = yield* Effect.tryPromise({
          try: () => options.certifications.list(),
          catch: (cause) =>
            new ProviderCatalogError({
              message: "Failed to read model certifications",
              cause
            })
        })
        const connections = yield* options.connections
        const catalogConnections = yield* Effect.forEach(
          connections,
          (connection) =>
            options.discover(connection, controller.signal).pipe(
              Effect.map((models) => ({
                connection,
                models: models.map((model) =>
                  decorate(
                    model,
                    connection,
                    certifications,
                    options.targetAvailable
                  )
                )
              }))
            ),
          { concurrency: "unbounded" }
        )
        return {
          connections: catalogConnections,
          refreshedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
          stale: false
        }
      }),
    (controller) => Effect.sync(() => controller.abort())
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(options.timeoutMs ?? 5_000),
      onTimeout: () =>
        new ProviderCatalogError({
          message: "Provider catalog refresh timed out"
        })
    })
  )

export const makeProviderCatalogService = (
  options: ProviderCatalogOptions
): Effect.Effect<ProviderCatalogShape> =>
  Effect.gen(function* () {
    const lastGood = yield* Ref.make<ProviderCatalog | null>(null)
    const refresh = loadCatalog(options).pipe(
      Effect.tap((catalog) => Ref.set(lastGood, catalog)),
      Effect.catchAll((error) =>
        Ref.get(lastGood).pipe(
          Effect.flatMap((catalog) =>
            catalog === null
              ? Effect.fail(error)
              : Effect.succeed({ ...catalog, stale: true })
          )
        )
      )
    )
    const list = Ref.get(lastGood).pipe(
      Effect.flatMap((catalog) =>
        catalog === null ? refresh : Effect.succeed(catalog)
      )
    )

    return {
      list,
      refresh,
      selectable: list.pipe(
        Effect.map((catalog) =>
          catalog.connections.flatMap(({ models }) =>
            models.filter((model) => model.selectable)
          )
        )
      )
    }
  })

import {
  authRouteIdentity,
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
import { Context, Data, Deferred, Duration, Effect, type Exit, Ref } from "effect"
import type { ModelCertificationStore } from "../certification/model-certification-store.js"

const DEFAULT_DISCOVERY_CONCURRENCY = 4

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
  /** Maximum provider connections discovered in parallel. */
  readonly discoveryConcurrency?: number
  readonly timeoutMs?: number
  readonly now?: () => number
}

const matchingCertification = (
  certifications: ReadonlyArray<ModelCertification>,
  connection: ProviderConnection,
  model: DiscoveredProviderModel
): ModelCertification | null => {
  const observedRoute = connection.subscription.observedRoute?.trim()
  if (observedRoute === undefined || observedRoute.length === 0) return null
  const connectionRouteIdentity = authRouteIdentity({
    observedRoute,
    subscription:
      connection.subscription.confirmedBillingRoute === "subscription"
  })
  const matching = certifications.filter(
    (item) =>
      item.providerId === model.providerId &&
      item.modelId === model.id &&
      item.authRoute.kind === connection.authKind &&
      authRouteIdentity(item.authRoute) === connectionRouteIdentity
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
    // Certification is advisory QA metadata; an authenticated connection's
    // models are usable without a per-model certification pass.
    selectable: authenticated && available,
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

const loadCertifications = (
  options: ProviderCatalogOptions
): Effect.Effect<ReadonlyArray<ModelCertification>, ProviderCatalogError> =>
  Effect.tryPromise({
    try: () => options.certifications.list(),
    catch: (cause) =>
      new ProviderCatalogError({
        message: "Failed to read model certifications",
        cause
      })
  })

const refreshCachedDecorations = (
  options: ProviderCatalogOptions,
  cached: ProviderCatalog
): Effect.Effect<ProviderCatalog> =>
  Effect.all({
    certifications: loadCertifications(options),
    connections: options.connections
  }).pipe(
    Effect.map(({ certifications, connections }) => ({
      connections: connections.map((connection) => {
        const cachedConnection = cached.connections.find(
          (entry) => entry.connection.id === connection.id
        )
        return {
          connection,
          models: (cachedConnection?.models ?? []).map((model) =>
            decorate(model, connection, certifications, options.targetAvailable)
          )
        }
      }),
      refreshedAt: cached.refreshedAt,
      stale: true
    })),
    Effect.catchAll(() => Effect.succeed({ ...cached, stale: true }))
  )

const loadCatalog = (
  options: ProviderCatalogOptions
): Effect.Effect<ProviderCatalog, ProviderCatalogError> => {
  const requestedConcurrency = options.discoveryConcurrency ?? DEFAULT_DISCOVERY_CONCURRENCY
  const discoveryConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : DEFAULT_DISCOVERY_CONCURRENCY

  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.gen(function* () {
        const certifications = yield* loadCertifications(options)
        const connections = yield* options.connections
        const catalogConnections = yield* Effect.forEach(
          connections,
          (connection) =>
            connection.status !== "authenticated"
              ? Effect.succeed({ connection, models: [] })
              : options.discover(connection, controller.signal).pipe(
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
          { concurrency: discoveryConcurrency }
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
}

type RefreshDeferred = Deferred.Deferred<ProviderCatalog, ProviderCatalogError>

type RefreshDecision =
  | { readonly kind: "cached"; readonly catalog: ProviderCatalog }
  | { readonly kind: "settled"; readonly deferred: RefreshDeferred }
  | { readonly kind: "await"; readonly deferred: RefreshDeferred }
  | { readonly kind: "lead"; readonly deferred: RefreshDeferred }

interface RefreshState {
  readonly lastGood: Ref.Ref<ProviderCatalog | null>
  readonly generation: Ref.Ref<number>
  readonly lastSettled: Ref.Ref<RefreshDeferred | null>
  readonly inFlight: Ref.Ref<RefreshDeferred | null>
  readonly lock: Effect.Semaphore
}

const makeRefreshState = (
  lastGood: Ref.Ref<ProviderCatalog | null>
): Effect.Effect<RefreshState> =>
  Effect.gen(function* () {
    return {
      lastGood,
      generation: yield* Ref.make(0),
      lastSettled: yield* Ref.make<RefreshDeferred | null>(null),
      inFlight: yield* Ref.make<RefreshDeferred | null>(null),
      lock: yield* Effect.makeSemaphore(1)
    }
  })

const selectRefresh = (
  state: RefreshState,
  reuseFreshCache: boolean,
  observedGeneration: number
): Effect.Effect<RefreshDecision> =>
  Effect.all({
    active: Ref.get(state.inFlight),
    currentGeneration: Ref.get(state.generation),
    cached: Ref.get(state.lastGood),
    settled: Ref.get(state.lastSettled)
  }).pipe(
    Effect.flatMap(({ active, currentGeneration, cached, settled }) => {
      if (active !== null) {
        return Effect.succeed<RefreshDecision>({ kind: "await", deferred: active })
      }
      if (reuseFreshCache && cached !== null && !cached.stale) {
        return Effect.succeed<RefreshDecision>({ kind: "cached", catalog: cached })
      }
      if (currentGeneration !== observedGeneration && settled !== null) {
        return Effect.succeed<RefreshDecision>({ kind: "settled", deferred: settled })
      }
      return Deferred.make<ProviderCatalog, ProviderCatalogError>().pipe(
        Effect.tap((deferred) => Ref.set(state.inFlight, deferred)),
        Effect.map((deferred): RefreshDecision => ({ kind: "lead", deferred }))
      )
    })
  )

const settleRefresh = (
  state: RefreshState,
  deferred: RefreshDeferred,
  exit: Exit.Exit<ProviderCatalog, ProviderCatalogError>
): Effect.Effect<void> =>
  state.lock.withPermits(1)(
    Deferred.done(deferred, exit).pipe(
      Effect.zipRight(Ref.set(state.lastSettled, deferred)),
      Effect.zipRight(Ref.update(state.generation, (generation) => generation + 1)),
      Effect.zipRight(Ref.set(state.inFlight, null))
    )
  )

const runRefreshDecision = (
  state: RefreshState,
  decision: RefreshDecision,
  performRefresh: Effect.Effect<ProviderCatalog, ProviderCatalogError>
): Effect.Effect<ProviderCatalog, ProviderCatalogError> => {
  switch (decision.kind) {
    case "cached":
      return Effect.succeed(decision.catalog)
    case "settled":
    case "await":
      return Deferred.await(decision.deferred)
    case "lead":
      return performRefresh.pipe(
        Effect.onExit((exit) => settleRefresh(state, decision.deferred, exit))
      )
  }
}

const coalescedRefresh = (
  state: RefreshState,
  performRefresh: Effect.Effect<ProviderCatalog, ProviderCatalogError>,
  reuseFreshCache: boolean
): Effect.Effect<ProviderCatalog, ProviderCatalogError> =>
  Effect.gen(function* () {
    const observedGeneration = yield* Ref.get(state.generation)
    const decision = yield* state.lock.withPermits(1)(
      selectRefresh(state, reuseFreshCache, observedGeneration)
    )
    return yield* runRefreshDecision(state, decision, performRefresh)
  })

export const makeProviderCatalogService = (
  options: ProviderCatalogOptions
): Effect.Effect<ProviderCatalogShape> =>
  Effect.gen(function* () {
    const lastGood = yield* Ref.make<ProviderCatalog | null>(null)
    const refreshState = yield* makeRefreshState(lastGood)
    const performRefresh = loadCatalog(options).pipe(
      Effect.tap((catalog) => Ref.set(lastGood, catalog)),
      Effect.catchAll((error) =>
        Ref.get(lastGood).pipe(
          Effect.flatMap((catalog) =>
            catalog === null
              ? Effect.fail(error)
              : refreshCachedDecorations(options, catalog).pipe(
                  Effect.tap((stale) => Ref.set(lastGood, stale))
                )
          )
        )
      )
    )
    const refreshFor = (reuseFreshCache: boolean) =>
      coalescedRefresh(refreshState, performRefresh, reuseFreshCache)
    const refresh = refreshFor(false)
    const list = Ref.get(lastGood).pipe(
      Effect.flatMap((catalog) =>
        catalog === null || catalog.stale
          ? refreshFor(true)
          : Effect.succeed(catalog)
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

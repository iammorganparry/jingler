import type {
  AgentRunSpec,
  AgentRuntimeId,
  StreamEvent,
  SubagentModelAssignments
} from "@jingler/core"
import { Effect } from "effect"
import { mcpCapabilityFingerprint } from "../tools/mcp-tools.js"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import type { PiSessionFactory, PiSessionHandle } from "./pi-agent-runtime.js"
import type { NativeSidecarOwner, NativeSidecarOwnerStore } from "./native-sidecar-owner-store.js"

export const nativeSidecarCapabilityFingerprint = (
  base: string,
  nativeSpec: AgentRunSpec,
  models: SubagentModelAssignments
): string => JSON.stringify({
  base,
  nativeRuntimeId: nativeSpec.runtimeId,
  nativeParentModelId: nativeSpec.modelId,
  models: Object.entries(models).sort(([left], [right]) => left.localeCompare(right))
})

interface ArchivedPiTranscript {
  readonly sessionId: string
  readonly chatId: string
  readonly targetId: string
  readonly nativeRuntimeId?: AgentRuntimeId
  readonly aliases: ReadonlySet<string>
  readonly read: PiSessionHandle["subagentTranscript"]
}

const NATIVE_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_TIMER_MS = 2_147_483_647

interface NativeRecoveryDescriptor {
  readonly owner: NativeSidecarOwner
  readonly spec: AgentRunSpec
  readonly context: AgentRuntimeContext
  readonly factory: PiSessionFactory
  opening?: Promise<RetainedPiSession>
  expiryTimer?: ReturnType<typeof setTimeout>
}

const lockedCapabilityFingerprint = (
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  dynamicCatalog = ""
): string => JSON.stringify({
  role: spec.role,
  mode: spec.mode,
  ponytailMode: spec.ponytailMode,
  targetId: spec.targetCapabilities.targetId,
  toolIds: [...spec.targetCapabilities.toolIds].sort(),
  resourceIds: [...spec.targetCapabilities.resourceIds].sort(),
  mcp: mcpCapabilityFingerprint(context.mcp),
  dynamicCatalog
})

export interface RetainedPiSession {
  readonly handle: PiSessionHandle
  readonly sessionId: string
  readonly chatId: string
  readonly connectionId: AgentRunSpec["connectionId"]
  readonly modelId: AgentRunSpec["modelId"]
  /** Tool and prompt capability shape locked when this PI session was built. */
  readonly capabilityFingerprint: string
  readonly aliases: ReadonlySet<string>
  /** The turn context every session-lifetime closure delegates to. */
  readonly contextHolder: { current: AgentRuntimeContext }
  readonly retainedByChat: boolean
  readonly targetId: string
  readonly cwd: string
  nativeRuntimeId?: AgentRuntimeId
  activeTurns: number
  idleSince: number | null
  reapTimer: ReturnType<typeof setTimeout> | null
  disposing: boolean
}

/**
 * A session-lifetime facade over the current turn's context.
 *
 * PI builds custom tools once, but their interactive callbacks and browser MCP
 * lease belong to one turn. Each acquire repoints this stable facade so a
 * retained session never calls the ended turn's mailbox or stale MCP endpoint.
 */
const publishDetachedEvent = (
  context: AgentRuntimeContext,
  event: StreamEvent
): Effect.Effect<void> => {
  switch (event._tag) {
    case "BackgroundTaskStarted":
    case "BackgroundTaskProgress":
    case "BackgroundTaskSettled":
    case "BackgroundTasksChanged":
      return context.publishEvent(event)
    default:
      return Effect.void
  }
}

const detachedPiSessionContext = (context: AgentRuntimeContext): AgentRuntimeContext => ({
  mcp: context.mcp === undefined
    ? undefined
    : { browser: null, configured: context.mcp.configured },
  publishEvent: (event) => publishDetachedEvent(context, event),
  recordUsage: context.recordUsage,
  registerBackgroundStop: context.registerBackgroundStop,
  canUseTool: context.canUseTool,
  askQuestion: () => Effect.succeed([]),
  publishExplanation: () => Effect.void
})

export const rebindablePiSessionContext = (
  holder: { current: AgentRuntimeContext }
): AgentRuntimeContext => ({
  get planning() { return holder.current.planning },
  get mcp() { return holder.current.mcp },
  isPlanReviewPending: () => holder.current.isPlanReviewPending?.() ?? false,
  publishEvent: (event) => holder.current.publishEvent(event),
  recordUsage: (fact) => holder.current.recordUsage?.(fact) ?? Effect.void,
  registerBackgroundStop: (stop) => holder.current.registerBackgroundStop(stop),
  canUseTool: (request) => holder.current.canUseTool(request),
  askQuestion: (request) => holder.current.askQuestion(request),
  publishExplanation: (explanation) =>
    holder.current.publishExplanation?.(explanation) ?? Effect.void,
  listPeerAgents: () => holder.current.listPeerAgents?.() ?? Effect.succeed([]),
  messagePeerAgent: (chatId, text) => holder.current.messagePeerAgent?.(chatId, text) ??
    Effect.die(new Error("Peer agent messaging is unavailable"))
})

/** Session/chat-owned PI handles retained until their final detached child settles. */
export class RetainedPiSessionRegistry {
  readonly #aliases = new Map<string, RetainedPiSession>()
  readonly #transcriptArchives = new Map<string, ArchivedPiTranscript>()
  readonly #archiveOrder: ArchivedPiTranscript[] = []
  readonly #recoveries = new Map<string, NativeRecoveryDescriptor>()
  readonly #chatAcquires = new Map<string, Promise<void>>()

  constructor(
    readonly factory: PiSessionFactory,
    readonly reapIntervalMs: number,
    readonly nativeIdleRetentionMs = 0,
    readonly nativeOwners?: Pick<NativeSidecarOwnerStore, "put" | "removeExact">,
    readonly nativeRecoveryRetentionMs = NATIVE_RECOVERY_RETENTION_MS
  ) {}

  acquire(
    spec: AgentRunSpec,
    context: AgentRuntimeContext
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    return this.#acquireWithFactory(spec, context, this.factory, false)
  }

  /** Native parent continuations are not PI IDs, so retained sidecars match by chat. */
  acquireByChat(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    nativeRuntimeId?: AgentRuntimeId
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const key = `${spec.sessionId}\u0000${spec.chatId}`
    return Effect.acquireUseRelease(
      Effect.promise(async () => {
        const previous = this.#chatAcquires.get(key) ?? Promise.resolve()
        let unlock!: () => void
        const lock = new Promise<void>((resolve) => { unlock = resolve })
        const queued = previous.then(() => lock)
        this.#chatAcquires.set(key, queued)
        await previous
        return { queued, unlock }
      }),
      () => this.#acquireWithFactory(spec, context, factory, true, nativeRuntimeId),
      ({ queued, unlock }) => Effect.sync(() => {
        unlock()
        if (this.#chatAcquires.get(key) === queued) this.#chatAcquires.delete(key)
      })
    )
  }

  /** Index one persisted owner for on-demand reopen without retaining credentials. */
  registerRecovery(
    owner: NativeSidecarOwner,
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory
  ): void {
    const descriptor: NativeRecoveryDescriptor = {
      owner,
      spec,
      context: detachedPiSessionContext(context),
      factory
    }
    this.#replaceRecovery(owner.continuationAlias, descriptor)
    this.#replaceRecovery(owner.parentRuntimeSessionId, descriptor)
    this.#scheduleRecoveryExpiry(descriptor)
  }

  #replaceRecovery(alias: string, descriptor: NativeRecoveryDescriptor): void {
    const previous = this.#recoveries.get(alias)
    if (previous !== undefined && previous !== descriptor) {
      if (this.#recoveries.get(previous.owner.continuationAlias) === previous) {
        this.#recoveries.delete(previous.owner.continuationAlias)
      }
      if (this.#recoveries.get(previous.owner.parentRuntimeSessionId) === previous) {
        this.#recoveries.delete(previous.owner.parentRuntimeSessionId)
      }
      if (previous.expiryTimer !== undefined) clearTimeout(previous.expiryTimer)
    }
    this.#recoveries.set(alias, descriptor)
  }

  #scheduleRecoveryExpiry(
    descriptor: NativeRecoveryDescriptor,
    delay = descriptor.owner.updatedAt + this.nativeRecoveryRetentionMs - Date.now()
  ): void {
    if (descriptor.expiryTimer !== undefined) clearTimeout(descriptor.expiryTimer)
    descriptor.expiryTimer = setTimeout(() => {
      descriptor.expiryTimer = undefined
      void this.#expireRecovery(descriptor)
    }, Math.max(0, Math.min(MAX_TIMER_MS, delay)))
    descriptor.expiryTimer.unref?.()
  }

  async #expireRecovery(descriptor: NativeRecoveryDescriptor): Promise<void> {
    if (
      this.#recoveries.get(descriptor.owner.continuationAlias) !== descriptor &&
      this.#recoveries.get(descriptor.owner.parentRuntimeSessionId) !== descriptor
    ) return
    const remaining = descriptor.owner.updatedAt + this.nativeRecoveryRetentionMs - Date.now()
    if (remaining > 0) {
      this.#scheduleRecoveryExpiry(descriptor)
      return
    }
    const live = this.#ownedRecord(
      descriptor.owner.sessionId,
      descriptor.owner.chatId,
      descriptor.owner.parentRuntimeSessionId,
      descriptor.owner.runtimeId
    )
    if (live !== undefined) {
      this.#scheduleRecoveryExpiry(descriptor, Math.min(MAX_TIMER_MS, this.reapIntervalMs))
      return
    }
    await this.#removeRecovery(descriptor)
  }

  /** Reopen one persisted native sidecar without prompting or spawning work. */
  recoverByChat(
    owner: NativeSidecarOwner,
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    if (!this.#recoveries.has(owner.parentRuntimeSessionId)) {
      this.registerRecovery(owner, spec, context, factory)
    }
    const existing = this.#aliases.get(owner.parentRuntimeSessionId)
    if (existing?.sessionId === owner.sessionId && existing.chatId === owner.chatId) {
      return Effect.succeed(existing)
    }
    const detached = detachedPiSessionContext(context)
    const contextHolder = { current: detached }
    const continuationSpec: AgentRunSpec = {
      ...spec,
      sessionId: owner.sessionId,
      chatId: owner.chatId,
      cwd: owner.cwd,
      targetCapabilities: {
        ...spec.targetCapabilities,
        targetId: owner.targetId
      },
      continuation: {
        runtimeId: spec.runtimeId,
        endpointId: spec.endpointId,
        id: owner.continuationAlias
      }
    }
    return factory.create(
      continuationSpec,
      rebindablePiSessionContext(contextHolder)
    ).pipe(
      Effect.flatMap((handle) => {
        if (handle.parentRuntimeSessionId !== owner.parentRuntimeSessionId) {
          return Effect.promise(async () => { await handle.dispose() }).pipe(
            Effect.flatMap(() => Effect.fail(new AgentRuntimeError({
              reason: "runtime",
              message: "Recovered native subagent host ownership does not match"
            })))
          )
        }
        const aliases = new Set([
          owner.continuationAlias,
          owner.parentRuntimeSessionId,
          handle.id,
          handle.parentRuntimeSessionId
        ])
        const record: RetainedPiSession = {
          handle,
          sessionId: owner.sessionId,
          chatId: owner.chatId,
          connectionId: spec.connectionId,
          modelId: spec.modelId,
          capabilityFingerprint: "recovered",
          aliases,
          contextHolder,
          retainedByChat: true,
          targetId: owner.targetId,
          cwd: owner.cwd,
          nativeRuntimeId: owner.runtimeId,
          activeTurns: 0,
          idleSince: null,
          reapTimer: null,
          disposing: false
        }
        this.#register(record)
        return Effect.tryPromise({
          try: () => this.#completeRecovery(record),
          catch: (cause) => new AgentRuntimeError({
            reason: "runtime",
            message: "Could not recover native subagent host",
            cause
          })
        })
      })
    )
  }

  #acquireWithFactory(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    byChat: boolean,
    nativeRuntimeId?: AgentRuntimeId
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const dynamicCatalog = factory.lockedCapabilityFingerprint?.(spec, context) ??
      Effect.succeed("")
    return dynamicCatalog.pipe(
      Effect.flatMap((dynamic) => this.#acquire(
        spec,
        context,
        factory,
        lockedCapabilityFingerprint(spec, context, dynamic),
        byChat,
        nativeRuntimeId
      ))
    )
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ownership, activity, and capability checks form one atomic acquisition gate.
  #acquire(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    capabilityFingerprint: string,
    byChat: boolean,
    nativeRuntimeId?: AgentRuntimeId
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const retained = byChat
      ? this.#recordByChat(spec.sessionId, spec.chatId)
      : spec.continuation === null
        ? undefined
        : this.#aliases.get(spec.continuation.id)
    if (retained) {
      if (retained.sessionId !== spec.sessionId || retained.chatId !== spec.chatId) {
        return Effect.fail(new AgentRuntimeError({
          reason: "runtime",
          message: "Retained Pi session does not belong to this chat"
        }))
      }
      if (retained.disposing || retained.activeTurns !== 0) {
        return Effect.fail(new AgentRuntimeError({
          reason: "runtime",
          message: `pi session is already active: ${spec.continuation?.id ?? retained.handle.id}`
        }))
      }
      if (
        retained.connectionId !== spec.connectionId ||
        retained.modelId !== spec.modelId ||
        retained.capabilityFingerprint !== capabilityFingerprint
      ) {
        if (byChat) {
          return this.#replaceIdleNativeHost(
            retained,
            spec,
            context,
            factory,
            capabilityFingerprint,
            nativeRuntimeId
          )
        }
        return Effect.promise(() => this.#dispose(retained)).pipe(
          Effect.flatMap(() => this.#create(
            spec,
            context,
            factory,
            capabilityFingerprint,
            undefined,
            byChat,
            nativeRuntimeId
          ))
        )
      }
      if (retained.reapTimer !== null) clearTimeout(retained.reapTimer)
      retained.reapTimer = null
      retained.activeTurns = 1
      retained.idleSince = null
      retained.contextHolder.current = context
      retained.nativeRuntimeId ??= nativeRuntimeId
      if (retained.handle.toolRegistry) context.planning?.attachRegistry(retained.handle.toolRegistry)
      return Effect.tryPromise({
        try: async () => {
          try {
            await this.#persistNativeOwner(retained, spec, context, factory)
            return retained
          } catch (cause) {
            retained.activeTurns = 0
            retained.contextHolder.current = detachedPiSessionContext(context)
            await this.#reconcileLifetime(retained)
            throw cause
          }
        },
        catch: (cause) => new AgentRuntimeError({
          reason: "runtime",
          message: "Could not update native subagent host ownership",
          cause
        })
      })
    }
    return this.#create(
      spec,
      context,
      factory,
      capabilityFingerprint,
      undefined,
      byChat,
      nativeRuntimeId
    )
  }

  #replaceIdleNativeHost(
    retained: RetainedPiSession,
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    capabilityFingerprint: string,
    nativeRuntimeId?: AgentRuntimeId
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    retained.activeTurns = 1
    return Effect.tryPromise({
      try: async () => {
        let active = true
        try {
          active = (await retained.handle.subagentFleetSnapshot()).totalActive > 0
        } catch {
          // An unreadable Fleet is not safe to replace.
        }
        if (active) {
          retained.activeTurns = 0
          await this.#reconcileLifetime(retained)
          if (retained.capabilityFingerprint === "recovered") {
            return await Effect.runPromise(this.#create(
              spec,
              context,
              factory,
              capabilityFingerprint,
              undefined,
              true,
              nativeRuntimeId
            ))
          }
          throw new AgentRuntimeError({
            reason: "runtime",
            message: "Native subagent host capabilities changed while detached work is active"
          })
        }
        const continuationId = retained.handle.id
        await this.#dispose(retained)
        return await Effect.runPromise(this.#create(
          spec,
          context,
          factory,
          capabilityFingerprint,
          continuationId,
          true,
          nativeRuntimeId
        ))
      },
      catch: (cause) => cause instanceof AgentRuntimeError
        ? cause
        : new AgentRuntimeError({
            reason: "runtime",
            message: "Could not replace idle native subagent host",
            cause
          })
    })
  }

  #create(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    capabilityFingerprint: string,
    continuationId?: string,
    retainedByChat = false,
    nativeRuntimeId?: AgentRuntimeId
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const contextHolder = { current: context }
    const createSpec = continuationId === undefined
      ? spec
      : {
          ...spec,
          continuation: {
            runtimeId: spec.runtimeId,
            endpointId: spec.endpointId,
            id: continuationId
          }
        }
    return factory.create(createSpec, rebindablePiSessionContext(contextHolder)).pipe(
      Effect.flatMap((handle) => {
        const aliases = new Set([handle.id, handle.parentRuntimeSessionId])
        const record: RetainedPiSession = {
          handle,
          sessionId: spec.sessionId,
          chatId: spec.chatId,
          connectionId: spec.connectionId,
          modelId: spec.modelId,
          capabilityFingerprint,
          aliases,
          contextHolder,
          retainedByChat,
          targetId: spec.targetCapabilities.targetId,
          cwd: spec.cwd,
          ...(nativeRuntimeId === undefined ? {} : { nativeRuntimeId }),
          activeTurns: 1,
          idleSince: null,
          reapTimer: null,
          disposing: false
        }
        this.#register(record)
        return Effect.tryPromise({
          try: async () => {
            try {
              await this.#persistNativeOwner(record, spec, context, factory)
              return record
            } catch (cause) {
              for (const alias of record.aliases) {
                if (this.#aliases.get(alias) === record) this.#aliases.delete(alias)
              }
              await handle.dispose()
              throw cause
            }
          },
          catch: (cause) => new AgentRuntimeError({
            reason: "runtime",
            message: "Could not persist native subagent host ownership",
            cause
          })
        })
      })
    )
  }

  async #completeRecovery(record: RetainedPiSession): Promise<RetainedPiSession> {
    try {
      await this.#persistNativeOwner(record)
    } catch (cause) {
      for (const alias of record.aliases) {
        if (this.#aliases.get(alias) === record) this.#aliases.delete(alias)
      }
      await record.handle.dispose()
      throw cause
    }
    try {
      await record.handle.subagentFleetSnapshot()
    } catch {
      // Keep the owner registered; an unreadable canonical snapshot is not safe to discard.
    } finally {
      this.#scheduleReconcile(record)
    }
    return record
  }

  #register(record: RetainedPiSession): void {
    for (const alias of record.aliases) {
      this.#transcriptArchives.delete(alias)
      this.#aliases.set(alias, record)
    }
  }

  async #persistNativeOwner(
    record: RetainedPiSession,
    spec?: AgentRunSpec,
    context?: AgentRuntimeContext,
    factory?: PiSessionFactory
  ): Promise<void> {
    if (
      !record.retainedByChat ||
      this.nativeOwners === undefined ||
      (record.nativeRuntimeId !== "claude" &&
        record.nativeRuntimeId !== "codex" &&
        record.nativeRuntimeId !== "opencode")
    ) return
    const value = {
      sessionId: record.sessionId,
      chatId: record.chatId,
      runtimeId: record.nativeRuntimeId,
      targetId: record.targetId,
      cwd: record.cwd,
      continuationAlias: record.handle.id,
      parentRuntimeSessionId: record.handle.parentRuntimeSessionId
    }
    const persisted = await this.nativeOwners.put(value)
    if (spec !== undefined && context !== undefined && factory !== undefined) {
      this.registerRecovery(persisted, spec, context, factory)
    }
  }

  lookup(id: string): PiSessionHandle | undefined {
    return this.#aliases.get(id)?.handle
  }

  #ownedRecord(
    sessionId: string,
    chatId: string,
    id: string,
    runtimeId?: AgentRuntimeId,
    targetId?: string
  ): RetainedPiSession | undefined {
    const record = this.#aliases.get(id)
    return record?.sessionId === sessionId &&
      record.chatId === chatId &&
      (targetId === undefined || record.targetId === targetId) &&
      (record.nativeRuntimeId === undefined || runtimeId === undefined || record.nativeRuntimeId === runtimeId)
      ? record
      : undefined
  }

  lookupOwned(
    sessionId: string,
    chatId: string,
    id: string,
    runtimeId?: AgentRuntimeId
  ): PiSessionHandle | undefined {
    return this.#ownedRecord(sessionId, chatId, id, runtimeId)?.handle
  }

  async resolveOwned(
    sessionId: string,
    chatId: string,
    id: string,
    runtimeId: AgentRuntimeId,
    targetId: string
  ): Promise<PiSessionHandle | undefined> {
    const live = this.#ownedRecord(sessionId, chatId, id, runtimeId, targetId)
    if (live !== undefined) return live.handle
    const descriptor = this.#recoveries.get(id)
    if (
      descriptor === undefined ||
      descriptor.owner.sessionId !== sessionId ||
      descriptor.owner.chatId !== chatId ||
      descriptor.owner.runtimeId !== runtimeId ||
      descriptor.owner.targetId !== targetId
    ) return undefined
    if (descriptor.opening === undefined) {
      descriptor.opening = Effect.runPromise(this.recoverByChat(
        descriptor.owner,
        descriptor.spec,
        descriptor.context,
        descriptor.factory
      ).pipe(
        Effect.tapError((cause) => this.#isDefinitiveRecoveryFailure(cause)
          ? Effect.promise(() => this.#removeRecovery(descriptor))
          : Effect.void)
      )).finally(() => {
        descriptor.opening = undefined
      })
    }
    return (await descriptor.opening).handle
  }

  #isDefinitiveRecoveryFailure(cause: unknown): boolean {
    let current: unknown = cause
    for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
      if (
        current instanceof AgentRuntimeError &&
        current.message === "Recovered native subagent host ownership does not match"
      ) return true
      if (typeof current === "object" && current !== null) {
        const candidate = current as { readonly code?: unknown; readonly cause?: unknown }
        if (candidate.code === "ENOENT") return true
        current = candidate.cause
      } else {
        break
      }
    }
    return false
  }

  async #removeRecovery(descriptor: NativeRecoveryDescriptor): Promise<void> {
    if (descriptor.expiryTimer !== undefined) {
      clearTimeout(descriptor.expiryTimer)
      descriptor.expiryTimer = undefined
    }
    for (const alias of [
      descriptor.owner.continuationAlias,
      descriptor.owner.parentRuntimeSessionId
    ]) {
      if (this.#recoveries.get(alias) === descriptor) this.#recoveries.delete(alias)
    }
    await this.nativeOwners?.removeExact(descriptor.owner)
  }

  #recordByChat(sessionId: string, chatId: string): RetainedPiSession | undefined {
    let recovered: RetainedPiSession | undefined
    for (const record of this.#aliases.values()) {
      if (record.sessionId !== sessionId || record.chatId !== chatId || record.disposing) continue
      if (record.capabilityFingerprint !== "recovered") return record
      recovered ??= record
    }
    return recovered
  }

  lookupByChat(sessionId: string, chatId: string): PiSessionHandle | undefined {
    return this.#recordByChat(sessionId, chatId)?.handle
  }

  lookupTranscriptOwned(
    sessionId: string,
    chatId: string,
    id: string,
    runtimeId?: AgentRuntimeId,
    targetId?: string
  ): PiSessionHandle["subagentTranscript"] | undefined {
    const live = this.#ownedRecord(sessionId, chatId, id, runtimeId, targetId)
    if (live !== undefined) return live.handle.subagentTranscript
    const archived = this.#transcriptArchives.get(id)
    return archived?.sessionId === sessionId &&
      archived.chatId === chatId &&
      (targetId === undefined || archived.targetId === targetId) &&
      (archived.nativeRuntimeId === undefined || runtimeId === undefined || archived.nativeRuntimeId === runtimeId)
      ? archived.read
      : undefined
  }

  async resolveTranscriptOwned(
    sessionId: string,
    chatId: string,
    id: string,
    runtimeId: AgentRuntimeId,
    targetId: string
  ): Promise<PiSessionHandle["subagentTranscript"] | undefined> {
    const read = this.lookupTranscriptOwned(sessionId, chatId, id, runtimeId, targetId)
    if (read !== undefined) return read
    return (await this.resolveOwned(sessionId, chatId, id, runtimeId, targetId))?.subagentTranscript
  }

  async release(record: RetainedPiSession): Promise<void> {
    record.activeTurns = Math.max(0, record.activeTurns - 1)
    if (record.activeTurns > 0 || record.disposing) return
    record.contextHolder.current = detachedPiSessionContext(record.contextHolder.current)
    await this.#reconcileLifetime(record)
  }

  #isCurrent(record: RetainedPiSession): boolean {
    return [...record.aliases].some((alias) => this.#aliases.get(alias) === record)
  }

  #scheduleReconcile(record: RetainedPiSession, delay = this.reapIntervalMs): void {
    if (record.reapTimer !== null) clearTimeout(record.reapTimer)
    record.reapTimer = setTimeout(() => {
      record.reapTimer = null
      void this.#reconcileLifetime(record)
    }, delay)
    record.reapTimer.unref?.()
  }

  async #reconcileLifetime(record: RetainedPiSession): Promise<void> {
    if (record.activeTurns > 0 || record.disposing || !this.#isCurrent(record)) return
    try {
      const snapshot = await record.handle.subagentFleetSnapshot()
      if (record.activeTurns > 0 || record.disposing || !this.#isCurrent(record)) return
      if (snapshot.totalActive === 0) {
        if (record.retainedByChat && this.nativeIdleRetentionMs > 0) {
          record.idleSince ??= Date.now()
          const remaining = this.nativeIdleRetentionMs - (Date.now() - record.idleSince)
          if (remaining > 0) {
            this.#scheduleReconcile(record, Math.min(this.reapIntervalMs, remaining))
            return
          }
        }
        await this.#dispose(record)
        return
      }
      record.idleSince = null
    } catch {
      // A failed status read is not evidence that detached children are gone.
    }
    if (record.activeTurns === 0 && !record.disposing && this.#isCurrent(record)) {
      this.#scheduleReconcile(record)
    }
  }

  async #dispose(record: RetainedPiSession): Promise<void> {
    if (record.disposing) return
    record.disposing = true
    if (record.reapTimer !== null) clearTimeout(record.reapTimer)
    record.reapTimer = null
    try {
      await record.handle.dispose()
    } finally {
      const archive: ArchivedPiTranscript = {
        sessionId: record.sessionId,
        chatId: record.chatId,
        targetId: record.targetId,
        ...(record.nativeRuntimeId === undefined ? {} : { nativeRuntimeId: record.nativeRuntimeId }),
        aliases: record.aliases,
        read: record.handle.subagentTranscript
      }
      for (const alias of record.aliases) {
        if (this.#aliases.get(alias) === record) this.#aliases.delete(alias)
        this.#transcriptArchives.set(alias, archive)
      }
      this.#archiveOrder.push(archive)
      while (this.#archiveOrder.length > 16) {
        const expired = this.#archiveOrder.shift()
        if (!expired) break
        for (const alias of expired.aliases) {
          if (this.#transcriptArchives.get(alias) === expired) {
            this.#transcriptArchives.delete(alias)
          }
        }
      }
    }
  }
}

export type RetainedPiFleetHandlers = Pick<
  AgentRuntimeShape,
  "controlSubagent" | "subagentFleetSnapshot" | "subagentTranscript"
>

/** Owner-checked Fleet operations shared by PI and retained native sidecars. */
export const retainedPiFleetHandlers = (
  sessions: RetainedPiSessionRegistry
): RetainedPiFleetHandlers => {
  const operation = <Value>(
    id: string,
    action: () => Promise<Value | undefined>
  ): Effect.Effect<Value, AgentRuntimeError> => Effect.tryPromise({
    try: async () => {
      const value = await action()
      if (value === undefined) throw new AgentRuntimeError({
        reason: "runtime",
        message: `pi session is not active: ${id}`
      })
      return value
    },
    catch: (cause) => cause instanceof AgentRuntimeError
      ? cause
      : new AgentRuntimeError({
          reason: "runtime",
          message: "pi session operation failed",
          cause
        })
  })

  return {
    controlSubagent: (owner, sessionId, chatId, request) => operation(
      request.parentRuntimeSessionId,
      async () => (await sessions.resolveOwned(
        sessionId,
        chatId,
        request.parentRuntimeSessionId,
        owner.runtimeId,
        owner.targetId
      ))?.controlSubagent(request)
    ),
    subagentFleetSnapshot: (owner, sessionId, chatId, parentRuntimeSessionId) => operation(
      parentRuntimeSessionId,
      async () => (await sessions.resolveOwned(
        sessionId,
        chatId,
        parentRuntimeSessionId,
        owner.runtimeId,
        owner.targetId
      ))?.subagentFleetSnapshot()
    ),
    subagentTranscript: (
      owner,
      sessionId,
      chatId,
      parentRuntimeSessionId,
      runId
    ) => operation(
      parentRuntimeSessionId,
      async () => (await sessions.resolveTranscriptOwned(
        sessionId,
        chatId,
        parentRuntimeSessionId,
        owner.runtimeId,
        owner.targetId
      ))?.(runId)
    )
  }
}

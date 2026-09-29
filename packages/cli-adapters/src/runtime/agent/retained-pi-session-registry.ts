import type { AgentRunSpec } from "@jingler/core"
import { Effect } from "effect"
import { mcpCapabilityFingerprint } from "../tools/mcp-tools.js"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { AgentRuntimeError } from "./agent-runtime.js"
import type { PiSessionFactory, PiSessionHandle } from "./pi-agent-runtime.js"

interface ArchivedPiTranscript {
  readonly sessionId: string
  readonly chatId: string
  readonly aliases: ReadonlySet<string>
  readonly read: PiSessionHandle["subagentTranscript"]
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
  activeTurns: number
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

  constructor(
    readonly factory: PiSessionFactory,
    readonly reapIntervalMs: number
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
    factory: PiSessionFactory
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    return this.#acquireWithFactory(spec, context, factory, true)
  }

  #acquireWithFactory(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    byChat: boolean
  ): Effect.Effect<RetainedPiSession, AgentRuntimeError> {
    const dynamicCatalog = factory.lockedCapabilityFingerprint?.(spec, context) ??
      Effect.succeed("")
    return dynamicCatalog.pipe(
      Effect.flatMap((dynamic) => this.#acquire(
        spec,
        context,
        factory,
        lockedCapabilityFingerprint(spec, context, dynamic),
        byChat
      ))
    )
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ownership, activity, and capability checks form one atomic acquisition gate.
  #acquire(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    capabilityFingerprint: string,
    byChat: boolean
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
            capabilityFingerprint
          )
        }
        return Effect.promise(() => this.#dispose(retained)).pipe(
          Effect.flatMap(() => this.#create(spec, context, factory, capabilityFingerprint))
        )
      }
      if (retained.reapTimer !== null) clearTimeout(retained.reapTimer)
      retained.reapTimer = null
      retained.activeTurns = 1
      retained.contextHolder.current = context
      if (retained.handle.toolRegistry) context.planning?.attachRegistry(retained.handle.toolRegistry)
      return Effect.succeed(retained)
    }
    return this.#create(spec, context, factory, capabilityFingerprint)
  }

  #replaceIdleNativeHost(
    retained: RetainedPiSession,
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    factory: PiSessionFactory,
    capabilityFingerprint: string
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
          continuationId
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
    continuationId?: string
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
      Effect.map((handle) => {
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
          activeTurns: 1,
          reapTimer: null,
          disposing: false
        }
        for (const alias of aliases) {
          this.#transcriptArchives.delete(alias)
          this.#aliases.set(alias, record)
        }
        return record
      })
    )
  }

  lookup(id: string): PiSessionHandle | undefined {
    return this.#aliases.get(id)?.handle
  }

  lookupOwned(
    sessionId: string,
    chatId: string,
    id: string
  ): PiSessionHandle | undefined {
    const record = this.#aliases.get(id)
    return record?.sessionId === sessionId && record.chatId === chatId
      ? record.handle
      : undefined
  }

  #recordByChat(sessionId: string, chatId: string): RetainedPiSession | undefined {
    for (const record of this.#aliases.values()) {
      if (record.sessionId === sessionId && record.chatId === chatId && !record.disposing) {
        return record
      }
    }
    return undefined
  }

  lookupByChat(sessionId: string, chatId: string): PiSessionHandle | undefined {
    return this.#recordByChat(sessionId, chatId)?.handle
  }

  lookupTranscriptOwned(
    sessionId: string,
    chatId: string,
    id: string
  ): PiSessionHandle["subagentTranscript"] | undefined {
    const live = this.#aliases.get(id)
    if (live?.sessionId === sessionId && live.chatId === chatId) {
      return live.handle.subagentTranscript
    }
    const archived = this.#transcriptArchives.get(id)
    return archived?.sessionId === sessionId && archived.chatId === chatId
      ? archived.read
      : undefined
  }

  async release(record: RetainedPiSession): Promise<void> {
    record.activeTurns = Math.max(0, record.activeTurns - 1)
    if (record.activeTurns > 0 || record.disposing) return
    await this.#reconcileLifetime(record)
  }

  async #reconcileLifetime(record: RetainedPiSession): Promise<void> {
    if (record.activeTurns > 0 || record.disposing) return
    try {
      const snapshot = await record.handle.subagentFleetSnapshot()
      if (snapshot.totalActive === 0) {
        await this.#dispose(record)
        return
      }
    } catch {
      // A failed status read is not evidence that detached children are gone.
    }
    if (record.reapTimer !== null) clearTimeout(record.reapTimer)
    record.reapTimer = setTimeout(() => {
      record.reapTimer = null
      void this.#reconcileLifetime(record)
    }, this.reapIntervalMs)
    record.reapTimer.unref?.()
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
    available: boolean,
    id: string,
    action: () => Promise<Value>
  ): Effect.Effect<Value, AgentRuntimeError> => available
    ? Effect.tryPromise({
        try: action,
        catch: (cause) => new AgentRuntimeError({
          reason: "runtime",
          message: "pi session operation failed",
          cause
        })
      })
    : Effect.fail(new AgentRuntimeError({
        reason: "runtime",
        message: `pi session is not active: ${id}`
      }))

  return {
    controlSubagent: (_owner, sessionId, chatId, request) => {
      const session = sessions.lookupOwned(sessionId, chatId, request.parentRuntimeSessionId)
      return operation(
        session !== undefined,
        request.parentRuntimeSessionId,
        () => session!.controlSubagent(request)
      )
    },
    subagentFleetSnapshot: (_owner, sessionId, chatId, parentRuntimeSessionId) => {
      const session = sessions.lookupOwned(sessionId, chatId, parentRuntimeSessionId)
      return operation(
        session !== undefined,
        parentRuntimeSessionId,
        () => session!.subagentFleetSnapshot()
      )
    },
    subagentTranscript: (
      _owner,
      sessionId,
      chatId,
      parentRuntimeSessionId,
      runId
    ) => {
      const read = sessions.lookupTranscriptOwned(
        sessionId,
        chatId,
        parentRuntimeSessionId
      )
      return operation(
        read !== undefined,
        parentRuntimeSessionId,
        () => read!(runId)
      )
    }
  }
}

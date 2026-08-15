import { MEMORY_CONFIG_DEFAULT } from "@jingler/core"
import type { AgentTurnSpec } from "./agent-turn-driver.js"
import { Context, Effect, Layer } from "effect"
import { ConfigService } from "./config.js"
import {
  MemoryService,
  type MemoryAttachment,
  type MemoryServiceEnvironment
} from "./memory.js"
import { composeTurnPrompt, leadsWithCommand } from "./turn-prompt.js"

export interface MemoryAttachmentServiceShape {
  readonly isConfigured?: () => Effect.Effect<boolean>
  readonly attachment: (
    query?: string,
    recallScope?: string
  ) => Effect.Effect<MemoryAttachment | null>
}

export class MemoryAttachmentService extends Context.Tag("@jingler/MemoryAttachmentService")<
  MemoryAttachmentService,
  MemoryAttachmentServiceShape
>() {}

/** Capture MemoryService's main-process dependencies once for independent PI roles. */
export const MemoryAttachmentServiceLive = Layer.effect(
  MemoryAttachmentService,
  Effect.gen(function* () {
    const memory = yield* MemoryService
    const environment = yield* Effect.context<MemoryServiceEnvironment>()
    return MemoryAttachmentService.of({
      isConfigured: () => ConfigService.get().pipe(
        Effect.provide(environment),
        Effect.map((config) => {
          const memory = config?.memory ?? MEMORY_CONFIG_DEFAULT
          return memory.enabled &&
            memory.organizationId !== null &&
            memory.organizationId.length > 0
        }),
        Effect.orElseSucceed(() => false)
      ),
      attachment: (query, recallScope) =>
        memory.attachment(query, recallScope).pipe(Effect.provide(environment))
    })
  })
)

/**
 * Add Jingler memory to any independently launched agent spec.
 *
 * AgentRunner already performs this enrichment for the main conversation. Plan
 * workers are separate harness launches, so they must cross the same boundary
 * explicitly; native sub-agents then inherit the worker's MCP collection.
 */
export const attachMemoryToSessionSpec = (
  spec: AgentTurnSpec,
  attachment: MemoryAttachment | null
): AgentTurnSpec =>
  attachment === null || spec.role === "context-digest"
    ? spec
    : {
        ...spec,
        memoryAttachmentStatus: "available",
        prompt: composeTurnPrompt(
          spec.prompt,
          { memory: attachment.instructions },
          { leadWithText: leadsWithCommand(spec.prompt) }
        ),
        mcp: { ...spec.mcp, memory: attachment.server }
      }

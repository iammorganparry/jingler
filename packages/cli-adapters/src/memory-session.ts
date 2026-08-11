import type { AgentTurnSpec } from "./agent-turn-driver.js"
import type { MemoryAttachment } from "./memory.js"
import { composeTurnPrompt } from "./turn-prompt.js"

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
  attachment === null
    ? spec
    : {
        ...spec,
        prompt: composeTurnPrompt(
          spec.prompt,
          { memory: attachment.instructions },
          { leadWithText: false }
        ),
        mcp: { ...spec.mcp, memory: attachment.server }
      }

import type { SessionSpec } from "./adapter.js"
import type { MemoryAttachment } from "./memory.js"
import { composeRemoteMcpServers } from "./mcp-config.js"
import { composeTurnPrompt } from "./turn-prompt.js"

/**
 * Add Jingler memory to any independently launched agent spec.
 *
 * AgentRunner already performs this enrichment for the main conversation. Plan
 * workers are separate harness launches, so they must cross the same boundary
 * explicitly; native sub-agents then inherit the worker's MCP collection.
 */
export const attachMemoryToSessionSpec = (
  spec: SessionSpec,
  attachment: MemoryAttachment | null
): SessionSpec =>
  attachment === null
    ? spec
    : {
        ...spec,
        prompt: composeTurnPrompt(
          spec.prompt,
          { memory: attachment.instructions },
          { leadWithText: false }
        ),
        remoteMcpServers: composeRemoteMcpServers(
          attachment.server,
          ...(spec.remoteMcpServers ?? [])
        )
      }

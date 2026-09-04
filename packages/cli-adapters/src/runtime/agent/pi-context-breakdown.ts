import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { ContextBreakdown } from "@jingler/core"

const estimatedTokens = (value: unknown): number =>
  Math.max(0, Math.ceil((JSON.stringify(value)?.length ?? 0) / 4))

const serialized = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

const messageCategory = (message: unknown): keyof ContextBreakdown => {
  const value = serialized(message)
  if (/jingler_load_resource|SKILL\.md|\/skills\//iu.test(value)) return "skills"
  if (/mcp_(?:search|call)|mcp__/iu.test(value)) return "mcps"
  if (/"role":"toolResult"|"role":"bashExecution"|"type":"toolCall"/u.test(value)) return "tools"
  return "messages"
}

/** Estimate category weights, then scale them to Pi's provider-reported total. */
export const estimatePiContextBreakdown = (
  session: Pick<AgentSession, "systemPrompt" | "getActiveToolNames" | "getAllTools" | "messages">,
  total: number
): ContextBreakdown => {
  const active = new Set(session.getActiveToolNames())
  const definitions = session.getAllTools().filter(({ name }) => active.has(name))
  const isMcp = ({ name }: { readonly name: string }) =>
    name.startsWith("mcp__") || name === "mcp_search" || name === "mcp_call"
  const raw: Record<keyof ContextBreakdown, number> = {
    systemPrompt: estimatedTokens(session.systemPrompt),
    tools: estimatedTokens(definitions.filter((tool) => !isMcp(tool))),
    skills: 0,
    mcps: estimatedTokens(definitions.filter(isMcp)),
    messages: 0
  }
  for (const message of session.messages) {
    const category = messageCategory(message)
    raw[category] += estimatedTokens(message)
  }
  const rawTotal = Object.values(raw).reduce((sum, value) => sum + value, 0)
  if (rawTotal === 0 || total <= 0) return raw
  const result: Record<keyof ContextBreakdown, number> = {
    systemPrompt: Math.floor(raw.systemPrompt * total / rawTotal),
    tools: Math.floor(raw.tools * total / rawTotal),
    skills: Math.floor(raw.skills * total / rawTotal),
    mcps: Math.floor(raw.mcps * total / rawTotal),
    messages: Math.floor(raw.messages * total / rawTotal)
  }
  const allocated = Object.values(result).reduce((sum, value) => sum + value, 0)
  return { ...result, messages: result.messages + total - allocated }
}

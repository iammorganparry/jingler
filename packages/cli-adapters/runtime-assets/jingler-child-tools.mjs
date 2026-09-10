import { readFileSync } from "node:fs"

const capabilityPath = process.env.JINGLER_SUBAGENT_CAPABILITY
if (!capabilityPath) {
  throw new Error("JINGLER_SUBAGENT_CAPABILITY is required")
}
const capability = JSON.parse(readFileSync(capabilityPath, "utf8"))
if (capability.version !== 1 || !Array.isArray(capability.tools)) {
  throw new Error("Unsupported Jingler child capability contract")
}

const render = (result) => {
  if (result.error) return `${result.error.code}: ${result.error.message}`
  if (result.preview !== null) return result.preview
  return result.value === null ? result.status : JSON.stringify(result.value)
}

export default function jinglerChildTools(pi) {
  const brokeredTools = capability.tools.map((tool) => tool.id)
  for (const tool of capability.tools) {
    pi.registerTool({
      name: tool.id,
      label: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(callId, parameters, signal) {
        const response = await fetch(capability.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            token: capability.token,
            parentPiSessionId: capability.parentPiSessionId,
            callId,
            toolId: tool.id,
            arguments: parameters
          }),
          signal
        })
        if (!response.ok) {
          throw new Error(`Jingler capability broker rejected ${tool.id} (${response.status})`)
        }
        const result = await response.json()
        return {
          content: [{ type: "text", text: render(result) }],
          details: result
        }
      }
    })
  }
  const activateBrokeredTools = () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...brokeredTools])])
  }
  pi.on("session_start", activateBrokeredTools)
  pi.on("before_agent_start", activateBrokeredTools)
}

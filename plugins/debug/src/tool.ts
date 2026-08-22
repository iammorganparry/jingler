import type { AgentToolDefinition } from "@jingler/plugin-sdk/host"
import { DEBUG_ACTIONS, decodeDebugInput } from "./contracts.js"
import type { DebugController } from "./controller.js"

const properties = {
  action: { type: "string", enum: DEBUG_ACTIONS }, program: { type: "string" },
  args: { type: "array", items: { type: "string" } }, adapter: { type: "string" }, cwd: { type: "string" },
  file: { type: "string" }, line: { type: "integer", minimum: 1 }, function: { type: "string" }, name: { type: "string" },
  condition: { type: "string" }, hit_condition: { type: "string" }, expression: { type: "string" }, context: { type: "string" },
  frame_id: { type: "integer" }, scope_id: { type: "integer", minimum: 1 }, variable_ref: { type: "integer", minimum: 1 },
  pid: { type: "integer", minimum: 1 }, port: { type: "integer", minimum: 1, maximum: 65_535 }, host: { type: "string" },
  levels: { type: "integer", minimum: 0, maximum: 65_536 },
  memory_reference: { type: "string" }, instruction_reference: { type: "string" },
  instruction_count: { type: "integer", minimum: 0, maximum: 65_536 }, instruction_offset: { type: "integer" },
  count: { type: "integer", minimum: 0, maximum: 65_536 }, data: { type: "string" }, data_id: { type: "string" },
  access_type: { type: "string", enum: ["read", "write", "readWrite"] }, command: { type: "string" },
  arguments: { type: "object" }, offset: { type: "integer" }, resolve_symbols: { type: "boolean" }, allow_partial: { type: "boolean" },
  start_module: { type: "integer", minimum: 0 }, module_count: { type: "integer", minimum: 0, maximum: 65_536 },
  timeout: { type: "number", minimum: 1, maximum: 300 }
} as const

export const debugAgentTool = (controller: DebugController): AgentToolDefinition => ({
  id: "debug",
  description: "Drive one DAP debugger session. Prefer this over shell commands for runtime state, breakpoints, stepping, variables, or thread inspection. Only one active debugger per Jingler session; program is a path, not a shell command; attach requires an explicit adapter.",
  inputSchema: { type: "object", properties, required: ["action"], additionalProperties: false },
  risk: "execute",
  idempotency: "unsafe",
  timeoutMs: 305_000,
  outputBudget: 32_000,
  cancellable: true,
  execute: (value, context) => controller.execute(decodeDebugInput(value), context)
})

import type { AgentToolDefinition } from "@jingler/plugin-sdk/host"
import { DEBUG_ACTIONS, decodeDebugInput } from "./contracts.js"
import type { DebugController } from "./controller.js"

const properties = {
  action: { type: "string", enum: DEBUG_ACTIONS }, program: { type: "string" },
  args: { type: "array", items: { type: "string" } }, adapter: { type: "string" }, cwd: { type: "string" },
  file: { type: "string" }, line: { type: "number" }, function: { type: "string" }, name: { type: "string" },
  condition: { type: "string" }, hit_condition: { type: "string" }, expression: { type: "string" }, context: { type: "string" },
  frame_id: { type: "number" }, scope_id: { type: "number" }, variable_ref: { type: "number" },
  pid: { type: "number" }, port: { type: "number" }, host: { type: "string" }, levels: { type: "number" },
  memory_reference: { type: "string" }, instruction_reference: { type: "string" }, instruction_count: { type: "number" },
  instruction_offset: { type: "number" }, count: { type: "number" }, data: { type: "string" }, data_id: { type: "string" },
  access_type: { type: "string", enum: ["read", "write", "readWrite"] }, command: { type: "string" },
  arguments: { type: "object" }, offset: { type: "number" }, resolve_symbols: { type: "boolean" }, allow_partial: { type: "boolean" },
  start_module: { type: "number" }, module_count: { type: "number" }, timeout: { type: "number", minimum: 1, maximum: 300 }
} as const

export const debugAgentTool = (controller: DebugController): AgentToolDefinition => ({
  id: "debug",
  description: "Drive one DAP debugger session. Prefer this over shell commands for runtime state, breakpoints, stepping, variables, or thread inspection. Only one active debugger per Jingler session; program is a path, not a shell command.",
  inputSchema: { type: "object", properties, required: ["action"], additionalProperties: false },
  risk: "execute",
  idempotency: "unsafe",
  timeoutMs: 305_000,
  outputBudget: 32_000,
  cancellable: true,
  execute: (value, context) => controller.execute(decodeDebugInput(value), context)
})

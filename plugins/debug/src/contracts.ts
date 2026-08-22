import { array, boolean, number, object, optional, parser, picklist, record, string, unknown } from "valibot"
import type { JsonObject } from "./dap/types.js"

export type { DebugViewSnapshot } from "@jingler/core"

export const DEBUG_ACTIONS = [
  "launch", "attach", "set_breakpoint", "remove_breakpoint",
  "set_instruction_breakpoint", "remove_instruction_breakpoint",
  "data_breakpoint_info", "set_data_breakpoint", "remove_data_breakpoint",
  "continue", "step_over", "step_in", "step_out", "pause", "evaluate",
  "stack_trace", "threads", "scopes", "variables", "disassemble",
  "read_memory", "write_memory", "modules", "loaded_sources",
  "custom_request", "output", "terminate", "sessions"
] as const
export type DebugAction = typeof DEBUG_ACTIONS[number]

export interface DebugInput extends JsonObject {
  readonly action: DebugAction
  readonly program?: string
  readonly args?: readonly string[]
  readonly adapter?: string
  readonly cwd?: string
  readonly file?: string
  readonly line?: number
  readonly function?: string
  readonly name?: string
  readonly condition?: string
  readonly hit_condition?: string
  readonly expression?: string
  readonly context?: string
  readonly frame_id?: number
  readonly scope_id?: number
  readonly variable_ref?: number
  readonly pid?: number
  readonly port?: number
  readonly host?: string
  readonly levels?: number
  readonly memory_reference?: string
  readonly instruction_reference?: string
  readonly instruction_count?: number
  readonly instruction_offset?: number
  readonly count?: number
  readonly data?: string
  readonly data_id?: string
  readonly access_type?: "read" | "write" | "readWrite"
  readonly command?: string
  readonly arguments?: JsonObject
  readonly offset?: number
  readonly resolve_symbols?: boolean
  readonly allow_partial?: boolean
  readonly start_module?: number
  readonly module_count?: number
  readonly timeout?: number
}

export interface DebugActionRecord {
  readonly id: number
  readonly action: DebugAction | "hover" | "control"
  readonly status: "running" | "success" | "error"
  readonly at: string
  readonly summary: string
}

export interface DebugRoute { readonly sessionId: string }
export interface DebugControl extends DebugRoute {
  readonly action: "pause" | "continue" | "step_over" | "step_in" | "step_out" | "terminate"
}
export interface DebugHover extends DebugRoute {
  readonly expression: string
  readonly frameId?: number
}

const optionalString = optional(string())
const optionalNumber = optional(number())
const debugInputSchema = object({
  action: picklist(DEBUG_ACTIONS),
  program: optionalString,
  args: optional(array(string())),
  adapter: optionalString,
  cwd: optionalString,
  file: optionalString,
  line: optionalNumber,
  function: optionalString,
  name: optionalString,
  condition: optionalString,
  hit_condition: optionalString,
  expression: optionalString,
  context: optionalString,
  frame_id: optionalNumber,
  scope_id: optionalNumber,
  variable_ref: optionalNumber,
  pid: optionalNumber,
  port: optionalNumber,
  host: optionalString,
  levels: optionalNumber,
  memory_reference: optionalString,
  instruction_reference: optionalString,
  instruction_count: optionalNumber,
  instruction_offset: optionalNumber,
  count: optionalNumber,
  data: optionalString,
  data_id: optionalString,
  access_type: optional(picklist(["read", "write", "readWrite"])),
  command: optionalString,
  arguments: optional(record(string(), unknown())),
  offset: optionalNumber,
  resolve_symbols: optional(boolean()),
  allow_partial: optional(boolean()),
  start_module: optionalNumber,
  module_count: optionalNumber,
  timeout: optionalNumber
})

export const decodeDebugInput = parser(debugInputSchema)
export const decodeDebugRoute = parser(object({ sessionId: string() }))
export const decodeDebugControl = parser(object({
  sessionId: string(),
  action: picklist(["pause", "continue", "step_over", "step_in", "step_out", "terminate"])
}))
export const decodeDebugHover = parser(object({
  sessionId: string(),
  expression: string(),
  frameId: optional(number())
}))

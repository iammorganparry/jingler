/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- This dispatcher translates validated tool inputs and opaque DAP results. */
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { AgentToolExecutionContext } from "@jingler/plugin-sdk/host"
import type {
  DebugAction,
  DebugActionRecord,
  DebugControl,
  DebugHover,
  DebugInput,
  DebugViewSnapshot
} from "./contracts.js"
import { resolveAdapter, resolveProgram, selectLaunchAdapter } from "./dap/config.js"
import { DapSession } from "./dap/session.js"
import type { DapScope, DapVariable, JsonObject } from "./dap/types.js"

const MAX_ACTIONS = 100
const HOVER_EXPRESSION = /^[A-Za-z_$][\w$]*$/u
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined || value === "") throw new Error(`debug ${name} is required.`)
  return value
}
const contained = async (root: string, value: string): Promise<string> => {
  const [canonicalRoot, canonicalValue] = await Promise.all([
    realpath(root),
    realpath(isAbsolute(value) ? value : resolve(root, value))
  ])
  const rel = relative(canonicalRoot, canonicalValue)
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Debug paths must stay inside the session worktree.")
  }
  return canonicalValue
}

interface State {
  session: DapSession | null
  scopes: DapScope[]
  variables: Record<number, readonly DapVariable[]>
  variablesFrameId?: number
  variablesStopSequence?: number
  actions: DebugActionRecord[]
  error: string | null
}

export class DebugController {
  readonly #states = new Map<string, State>()
  #actionId = 0

  async execute(input: DebugInput, context: AgentToolExecutionContext): Promise<unknown> {
    const state = this.#state(context.session.id)
    const action = this.#start(state, input.action)
    try {
      const result = await this.#dispatch(state, input, context)
      this.#finish(state, action.id, "success", this.#summary(input.action, result))
      return result
    } catch (cause) {
      state.error = message(cause)
      this.#finish(state, action.id, "error", state.error)
      throw cause
    }
  }

  async snapshot(sessionId: string): Promise<DebugViewSnapshot> {
    const state = this.#states.get(sessionId)
    if (!state) return { active: false, session: null, scopes: [], variables: {}, actions: [], error: null }
    await this.#refreshVariables(state)
    return {
      active: state.session !== null && state.session.snapshot().status !== "terminated",
      session: state.session?.snapshot() ?? null,
      scopes: state.scopes,
      variables: state.variables,
      actions: state.actions,
      error: state.error
    }
  }

  async control(input: DebugControl): Promise<DebugViewSnapshot> {
    const state = this.#requiredState(input.sessionId)
    const action = this.#start(state, "control", input.action)
    try {
      await this.#runControl(state.session!, input.action)
      this.#finish(state, action.id, "success", input.action)
      return this.snapshot(input.sessionId)
    } catch (cause) {
      this.#finish(state, action.id, "error", message(cause))
      throw cause
    }
  }

  async hover(input: DebugHover, signal?: AbortSignal): Promise<JsonObject> {
    if (!HOVER_EXPRESSION.test(input.expression)) {
      throw new Error("Only identifier expressions can be evaluated from source hover.")
    }
    const state = this.#requiredState(input.sessionId)
    if (state.session!.snapshot().status !== "stopped") throw new Error("The debugger is not stopped.")
    return state.session!.evaluate(input.expression, input.frameId, "hover", signal)
  }

  async disposeSession(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId)
    this.#states.delete(sessionId)
    await state?.session?.dispose()
  }

  async dispose(): Promise<void> {
    const states = [...this.#states.values()]
    this.#states.clear()
    await Promise.all(states.map((state) => state.session?.dispose()))
  }

  async #dispatch(state: State, input: DebugInput, context: AgentToolExecutionContext): Promise<unknown> {
    const root = context.session.repository.path
    const cwd = await contained(root, input.cwd ?? root)
    const signal = context.signal
    if (input.action === "launch") {
      const program = await contained(root, resolveProgram(cwd, required(input.program, "program")))
      const adapter = selectLaunchAdapter(cwd, program, input.adapter)
      await state.session?.dispose()
      state.session = null
      state.session = await DapSession.launch({
        adapter, cwd, program,
        args: input.args, signal
      })
      state.scopes = []
      state.variables = {}
      state.variablesFrameId = undefined
      state.variablesStopSequence = undefined
      return state.session.snapshot()
    }
    if (input.action === "attach") {
      const adapter = resolveAdapter(cwd, required(input.adapter, "adapter"))
      await state.session?.dispose()
      state.session = null
      state.session = await DapSession.attach({
        adapter, cwd, pid: input.pid,
        port: input.port, host: input.host, signal
      })
      state.scopes = []
      state.variables = {}
      state.variablesFrameId = undefined
      state.variablesStopSequence = undefined
      return state.session.snapshot()
    }
    if (input.action === "sessions") return state.session ? [state.session.snapshot()] : []
    const session = required(state.session ?? undefined, "active session")
    switch (input.action) {
      case "set_breakpoint":
      case "remove_breakpoint": {
        const remove = input.action === "remove_breakpoint"
        if (input.function) return session.setFunctionBreakpoint(input.function, input.condition, remove, signal)
        return session.setSourceBreakpoint(await contained(root, required(input.file, "file")), required(input.line, "line"), input.condition, remove, signal)
      }
      case "set_instruction_breakpoint":
      case "remove_instruction_breakpoint":
        return session.setInstructionBreakpoint({
          instructionReference: required(input.instruction_reference, "instruction_reference"),
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.condition ? { condition: input.condition } : {}),
          ...(input.hit_condition ? { hitCondition: input.hit_condition } : {})
        }, input.action === "remove_instruction_breakpoint", signal)
      case "data_breakpoint_info":
        return session.dataBreakpointInfo(required(input.name, "name"), input.frame_id, input.variable_ref ?? input.scope_id, signal)
      case "set_data_breakpoint":
      case "remove_data_breakpoint":
        return session.setDataBreakpoint({
          dataId: required(input.data_id, "data_id"),
          ...(input.access_type ? { accessType: input.access_type } : {}),
          ...(input.condition ? { condition: input.condition } : {}),
          ...(input.hit_condition ? { hitCondition: input.hit_condition } : {})
        }, input.action === "remove_data_breakpoint", signal)
      case "continue": return session.continue("continue", signal, (input.timeout ?? 30) * 1_000)
      case "step_over": return session.continue("next", signal, (input.timeout ?? 30) * 1_000)
      case "step_in": return session.continue("stepIn", signal, (input.timeout ?? 30) * 1_000)
      case "step_out": return session.continue("stepOut", signal, (input.timeout ?? 30) * 1_000)
      case "pause": return session.pause(signal)
      case "evaluate": return session.evaluate(required(input.expression, "expression"), input.frame_id, input.context, signal)
      case "threads": return session.threads(signal)
      case "stack_trace": return session.stackTrace(undefined, input.levels, signal)
      case "scopes": return session.scopes(input.frame_id, signal)
      case "variables": return session.variables(required(input.variable_ref ?? input.scope_id, "variable_ref or scope_id"), signal)
      case "disassemble": return session.raw("disassemble", {
        memoryReference: required(input.memory_reference ?? session.snapshot().frame?.instructionPointerReference, "memory_reference"),
        instructionCount: required(input.instruction_count, "instruction_count"),
        ...(input.instruction_offset === undefined ? {} : { instructionOffset: input.instruction_offset }),
        ...(input.resolve_symbols === undefined ? {} : { resolveSymbols: input.resolve_symbols })
      }, "supportsDisassembleRequest", signal)
      case "read_memory": return session.raw("readMemory", {
        memoryReference: required(input.memory_reference, "memory_reference"),
        count: required(input.count, "count"),
        ...(input.offset === undefined ? {} : { offset: input.offset })
      }, "supportsReadMemoryRequest", signal)
      case "write_memory": return session.raw("writeMemory", {
        memoryReference: required(input.memory_reference, "memory_reference"),
        data: required(input.data, "data"),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.allow_partial === undefined ? {} : { allowPartial: input.allow_partial })
      }, "supportsWriteMemoryRequest", signal)
      case "modules": return session.raw("modules", {
        ...(input.start_module === undefined ? {} : { startModule: input.start_module }),
        ...(input.module_count === undefined ? {} : { moduleCount: input.module_count })
      }, "supportsModulesRequest", signal)
      case "loaded_sources": return session.raw("loadedSources", {}, "supportsLoadedSourcesRequest", signal)
      case "custom_request": return session.raw(required(input.command, "command"), input.arguments ?? {}, undefined, signal)
      case "output": return { output: session.snapshot().output }
      case "terminate": await session.terminate(signal); return session.snapshot()
      default: input.action satisfies never
    }
  }

  async #runControl(session: DapSession, action: DebugControl["action"]): Promise<void> {
    if (action === "pause") { await session.pause(); return }
    if (action === "terminate") { await session.terminate(); return }
    const command = action === "continue" ? "continue" : action === "step_over" ? "next" : action === "step_in" ? "stepIn" : "stepOut"
    await session.continue(command)
  }

  async #refreshVariables(state: State): Promise<void> {
    const session = state.session
    if (session?.snapshot().status !== "stopped") {
      state.scopes = []
      state.variables = {}
      state.variablesFrameId = undefined
      state.variablesStopSequence = undefined
      return
    }
    const snapshot = session.snapshot()
    const frameId = snapshot.frame?.id
    const stopSequence = snapshot.stopSequence
    if (
      frameId === undefined ||
      stopSequence === undefined ||
      (state.variablesFrameId === frameId && state.variablesStopSequence === stopSequence)
    ) return
    state.scopes = []
    state.variables = {}
    state.variablesFrameId = undefined
    state.variablesStopSequence = undefined
    try {
      const scopes = [...await session.scopes(frameId)]
      const pairs = await Promise.all(scopes.map(async (scope) => [scope.variablesReference, await session.variables(scope.variablesReference)] as const))
      const current = session.snapshot()
      if (current.frame?.id !== frameId || current.stopSequence !== stopSequence) return
      state.scopes = scopes
      state.variables = Object.fromEntries(pairs)
      state.variablesFrameId = frameId
      state.variablesStopSequence = stopSequence
    } catch { /* a later poll retries without showing values from an earlier stop */ }
  }

  #state(id: string): State {
    const current = this.#states.get(id)
    if (current) return current
    const state: State = { session: null, scopes: [], variables: {}, actions: [], error: null }
    this.#states.set(id, state)
    return state
  }

  #requiredState(id: string): State {
    const state = this.#states.get(id)
    if (!state?.session) throw new Error("No debugger is active for this session.")
    return state
  }

  #start(state: State, action: DebugActionRecord["action"], summary = action): DebugActionRecord {
    const record: DebugActionRecord = { id: ++this.#actionId, action, status: "running", at: new Date().toISOString(), summary }
    state.actions = [...state.actions, record].slice(-MAX_ACTIONS)
    state.error = null
    return record
  }

  #finish(state: State, id: number, status: "success" | "error", summary: string): void {
    state.actions = state.actions.map((item) => item.id === id ? { ...item, status, summary } : item)
  }

  #summary(action: DebugAction, result: unknown): string {
    if (typeof result === "object" && result !== null && "status" in result) return `${action}: ${String((result as { status: unknown }).status)}`
    return action
  }
}

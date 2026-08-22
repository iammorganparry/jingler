/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- DAP responses are an external protocol boundary and optional wire fields must be omitted. */
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import type {
  DapBreakpoint,
  DapCapabilities,
  DapEvent,
  DapResolvedAdapter,
  DapScope,
  DapSessionSnapshot,
  DapStackFrame,
  DapThread,
  DapVariable,
  JsonObject
} from "./types.js"
import { DapClient } from "./client.js"

const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : []
const num = (value: unknown): number | undefined => typeof value === "number" ? value : undefined
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const MAX_OUTPUT = 128_000

interface SourceBreakpoint { readonly line: number; readonly condition?: string }
interface FunctionBreakpoint { readonly name: string; readonly condition?: string }
interface InstructionBreakpoint { readonly instructionReference: string; readonly offset?: number; readonly condition?: string; readonly hitCondition?: string }
interface DataBreakpoint { readonly dataId: string; readonly accessType?: string; readonly condition?: string; readonly hitCondition?: string }

export class DapSession {
  readonly id = randomUUID()
  readonly adapter: DapResolvedAdapter
  readonly cwd: string
  readonly program?: string
  readonly #client: DapClient
  readonly #sourceBreakpoints = new Map<string, SourceBreakpoint[]>()
  #functionBreakpoints: FunctionBreakpoint[] = []
  #instructionBreakpoints: InstructionBreakpoint[] = []
  #dataBreakpoints: DataBreakpoint[] = []
  #capabilities: DapCapabilities = {}
  #status: DapSessionSnapshot["status"] = "starting"
  #stopReason?: string
  #stopSequence = 0
  #threadId?: number
  #frame?: DapStackFrame
  #threads: DapThread[] = []
  #stackFrames: DapStackFrame[] = []
  #verifiedBreakpoints: Record<string, DapBreakpoint[]> = {}
  #output = ""
  #exitCode?: number
  #configurationDone = false
  #configurationPromise?: Promise<void>
  #listeners = new Set<() => void>()
  #eventWaiters = new Set<(event: DapEvent) => void>()

  private constructor(client: DapClient, adapter: DapResolvedAdapter, cwd: string, program?: string) {
    this.#client = client
    this.adapter = adapter
    this.cwd = cwd
    this.program = program
    client.onEvent((event) => this.#onEvent(event))
  }

  static async launch(input: {
    adapter: DapResolvedAdapter
    cwd: string
    program: string
    args?: readonly string[]
    signal?: AbortSignal
  }): Promise<DapSession> {
    const info = await stat(input.program)
    if (info.isDirectory() && !input.adapter.acceptsDirectoryProgram) {
      throw new Error(`Adapter ${input.adapter.name} cannot launch a directory.`)
    }
    const client = await DapClient.spawn(input.adapter, input.cwd)
    const session = new DapSession(client, input.adapter, input.cwd, input.program)
    try {
      await session.#initialize(input.signal)
      await client.request("launch", {
        ...input.adapter.launchDefaults,
        request: "launch",
        program: input.program,
        cwd: input.cwd,
        args: [...(input.args ?? [])]
      }, input.signal)
      session.#status = "running"
      session.#notify()
      return session
    } catch (cause) {
      await client.dispose()
      throw cause
    }
  }

  static async attach(input: {
    adapter: DapResolvedAdapter
    cwd: string
    pid?: number
    port?: number
    host?: string
    signal?: AbortSignal
  }): Promise<DapSession> {
    const client = await DapClient.spawn(input.adapter, input.cwd)
    const session = new DapSession(client, input.adapter, input.cwd)
    try {
      await session.#initialize(input.signal)
      await client.request("attach", {
        ...input.adapter.attachDefaults,
        request: "attach",
        ...(input.pid === undefined ? {} : { processId: input.pid, pid: input.pid }),
        ...(input.port === undefined ? {} : { port: input.port }),
        ...(input.host === undefined ? {} : { host: input.host })
      }, input.signal)
      session.#status = "running"
      session.#notify()
      return session
    } catch (cause) {
      await client.dispose()
      throw cause
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot(): DapSessionSnapshot {
    return {
      id: this.id,
      adapter: this.adapter.name,
      cwd: this.cwd,
      ...(this.program ? { program: this.program } : {}),
      status: this.#status,
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
      ...(this.#stopSequence === 0 ? {} : { stopSequence: this.#stopSequence }),
      ...(this.#threadId === undefined ? {} : { threadId: this.#threadId }),
      ...(this.#frame ? { frame: this.#frame } : {}),
      threads: this.#threads,
      stackFrames: this.#stackFrames,
      breakpoints: this.#verifiedBreakpoints,
      output: this.#output,
      ...(this.#exitCode === undefined ? {} : { exitCode: this.#exitCode })
    }
  }

  async setSourceBreakpoint(file: string, line: number, condition?: string, remove = false, signal?: AbortSignal): Promise<readonly DapBreakpoint[]> {
    const current = this.#sourceBreakpoints.get(file) ?? []
    const next = remove
      ? current.filter((item) => item.line !== line)
      : [...current.filter((item) => item.line !== line), { line, ...(condition ? { condition } : {}) }].sort((a, b) => a.line - b.line)
    this.#sourceBreakpoints.set(file, next)
    const body = await this.#client.request("setBreakpoints", { source: { path: file }, breakpoints: next }, signal)
    const breakpoints = array<DapBreakpoint>(body.breakpoints)
    this.#verifiedBreakpoints = { ...this.#verifiedBreakpoints, [file]: breakpoints }
    this.#notify()
    return breakpoints
  }

  async setFunctionBreakpoint(name: string, condition?: string, remove = false, signal?: AbortSignal): Promise<readonly DapBreakpoint[]> {
    this.#functionBreakpoints = remove
      ? this.#functionBreakpoints.filter((item) => item.name !== name)
      : [...this.#functionBreakpoints.filter((item) => item.name !== name), { name, ...(condition ? { condition } : {}) }]
    const body = await this.#client.request("setFunctionBreakpoints", { breakpoints: this.#functionBreakpoints }, signal)
    return array<DapBreakpoint>(body.breakpoints)
  }

  async setInstructionBreakpoint(value: InstructionBreakpoint, remove = false, signal?: AbortSignal): Promise<readonly DapBreakpoint[]> {
    this.#require("supportsInstructionBreakpoints")
    this.#instructionBreakpoints = remove
      ? this.#instructionBreakpoints.filter((item) => item.instructionReference !== value.instructionReference)
      : [...this.#instructionBreakpoints.filter((item) => item.instructionReference !== value.instructionReference), value]
    const body = await this.#client.request("setInstructionBreakpoints", { breakpoints: this.#instructionBreakpoints }, signal)
    return array<DapBreakpoint>(body.breakpoints)
  }

  async dataBreakpointInfo(name: string, frameId?: number, variablesReference?: number, signal?: AbortSignal): Promise<JsonObject> {
    this.#require("supportsDataBreakpoints")
    return this.#client.request("dataBreakpointInfo", {
      name,
      ...(frameId === undefined ? {} : { frameId }),
      ...(variablesReference === undefined ? {} : { variablesReference })
    }, signal)
  }

  async setDataBreakpoint(value: DataBreakpoint, remove = false, signal?: AbortSignal): Promise<readonly DapBreakpoint[]> {
    this.#require("supportsDataBreakpoints")
    this.#dataBreakpoints = remove
      ? this.#dataBreakpoints.filter((item) => item.dataId !== value.dataId)
      : [...this.#dataBreakpoints.filter((item) => item.dataId !== value.dataId), value]
    const body = await this.#client.request("setDataBreakpoints", { breakpoints: this.#dataBreakpoints }, signal)
    return array<DapBreakpoint>(body.breakpoints)
  }

  async continue(kind: "continue" | "next" | "stepIn" | "stepOut", signal?: AbortSignal, timeoutMs = 30_000): Promise<DapSessionSnapshot> {
    await this.#configuration(signal)
    const threadId = this.#threadId ?? (await this.threads(signal))[0]?.id
    if (threadId === undefined) throw new Error("No debug thread is available.")
    this.#status = "running"
    this.#frame = undefined
    this.#stackFrames = []
    this.#notify()
    const waiter = new AbortController()
    const cancelWait = () => waiter.abort()
    signal?.addEventListener("abort", cancelWait, { once: true })
    const stopped = this.#waitFor(["stopped", "terminated", "exited"], timeoutMs, waiter.signal)
    try {
      await this.#client.request(kind, { threadId }, signal)
      await stopped
    } catch (cause) {
      waiter.abort()
      await stopped.catch(() => {})
      throw cause
    } finally {
      signal?.removeEventListener("abort", cancelWait)
    }
    const outcome = this.snapshot()
    if (outcome.status === "stopped" && outcome.frame === undefined) {
      await this.#refreshStop()
    }
    return this.snapshot()
  }

  async pause(signal?: AbortSignal): Promise<DapSessionSnapshot> {
    const threadId = this.#threadId ?? (await this.threads(signal))[0]?.id
    if (threadId === undefined) throw new Error("No debug thread is available.")
    const waiter = new AbortController()
    const cancelWait = () => waiter.abort()
    signal?.addEventListener("abort", cancelWait, { once: true })
    const stopped = this.#waitFor(["stopped"], 30_000, waiter.signal)
    try {
      await this.#client.request("pause", { threadId }, signal)
      await stopped
      return this.snapshot()
    } catch (cause) {
      waiter.abort()
      await stopped.catch(() => {})
      throw cause
    } finally {
      signal?.removeEventListener("abort", cancelWait)
    }
  }

  async threads(signal?: AbortSignal): Promise<readonly DapThread[]> {
    const body = await this.#client.request("threads", {}, signal)
    this.#threads = array<DapThread>(body.threads)
    this.#notify()
    return this.#threads
  }

  async stackTrace(threadId = this.#threadId, levels?: number, signal?: AbortSignal): Promise<readonly DapStackFrame[]> {
    if (threadId === undefined) throw new Error("No stopped thread is available.")
    const body = await this.#client.request("stackTrace", { threadId, ...(levels === undefined ? {} : { levels }) }, signal)
    this.#stackFrames = array<DapStackFrame>(body.stackFrames)
    this.#frame = this.#stackFrames[0]
    this.#notify()
    return this.#stackFrames
  }

  async scopes(frameId = this.#frame?.id, signal?: AbortSignal): Promise<readonly DapScope[]> {
    if (frameId === undefined) throw new Error("No stopped frame is available.")
    return array<DapScope>((await this.#client.request("scopes", { frameId }, signal)).scopes)
  }

  async variables(variablesReference: number, signal?: AbortSignal): Promise<readonly DapVariable[]> {
    return array<DapVariable>((await this.#client.request("variables", { variablesReference }, signal)).variables)
  }

  evaluate(expression: string, frameId = this.#frame?.id, context = "repl", signal?: AbortSignal): Promise<JsonObject> {
    return this.#client.request("evaluate", { expression, context, ...(frameId === undefined ? {} : { frameId }) }, signal)
  }

  async raw(command: string, args: JsonObject, capability?: keyof DapCapabilities, signal?: AbortSignal): Promise<JsonObject> {
    if (capability) this.#require(capability)
    return this.#client.request(command, args, signal)
  }

  async terminate(signal?: AbortSignal): Promise<void> {
    if (this.#capabilities.supportsTerminateRequest) {
      try { await this.#client.request("terminate", {}, signal, 5_000) } catch { /* disconnect below */ }
    }
    try { await this.#client.request("disconnect", { terminateDebuggee: true }, signal, 5_000) } catch { /* process cleanup is authoritative */ }
    this.#status = "terminated"
    this.#notify()
    await this.#client.dispose()
  }

  dispose(): Promise<void> { return this.terminate() }

  async #initialize(signal?: AbortSignal): Promise<void> {
    const body = await this.#client.request("initialize", {
      clientID: "jingler",
      clientName: "Jingler",
      adapterID: this.adapter.name,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: true,
      supportsVariableType: true,
      supportsMemoryReferences: true
    }, signal)
    this.#capabilities = body as DapCapabilities
  }

  async #configuration(signal?: AbortSignal): Promise<void> {
    if (this.#configurationDone) return
    this.#configurationPromise ??= (async () => {
      if (this.#capabilities.supportsConfigurationDoneRequest !== false) {
        await this.#client.request("configurationDone", {}, signal)
      }
      this.#configurationDone = true
    })()
    try {
      await this.#configurationPromise
    } catch (cause) {
      this.#configurationPromise = undefined
      throw cause
    }
  }

  #require(capability: keyof DapCapabilities): void {
    if (this.#capabilities[capability] !== true) throw new Error(`Debug adapter does not support ${capability}.`)
  }

  #waitFor(names: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<DapEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Debugger did not emit ${names.join("/")} in time.`)) }, timeoutMs)
      const waiter = (event: DapEvent) => {
        if (!names.includes(event.event)) return
        cleanup()
        resolve(event)
      }
      const abort = () => { cleanup(); reject(new Error("Debug wait was cancelled.")) }
      const cleanup = () => {
        clearTimeout(timer)
        this.#eventWaiters.delete(waiter)
        signal?.removeEventListener("abort", abort)
      }
      this.#eventWaiters.add(waiter)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  #onEvent(event: DapEvent): void {
    for (const waiter of [...this.#eventWaiters]) waiter(event)
    const body = event.body ?? {}
    if (event.event === "initialized") {
      this.#configuration().catch(() => {})
    } else if (event.event === "output") {
      this.#output = `${this.#output}${text(body.output) ?? ""}`.slice(-MAX_OUTPUT)
    } else if (event.event === "stopped") {
      this.#status = "stopped"
      this.#stopSequence += 1
      this.#stopReason = text(body.reason)
      this.#threadId = num(body.threadId)
      this.#refreshStop().catch(() => {})
    } else if (event.event === "continued") {
      this.#status = "running"
      this.#frame = undefined
      this.#stackFrames = []
    } else if (event.event === "exited" || event.event === "terminated") {
      this.#status = "terminated"
      this.#exitCode = num(body.exitCode)
      this.#frame = undefined
    }
    this.#notify()
  }

  async #refreshStop(): Promise<void> {
    try {
      const threads = await this.threads()
      if (this.#threadId === undefined) this.#threadId = threads[0]?.id
      if (this.#threadId !== undefined) await this.stackTrace(this.#threadId)
    } catch {
      // The stopped snapshot remains useful even if an adapter races shutdown.
    }
  }

  #notify(): void { for (const listener of this.#listeners) listener() }
}

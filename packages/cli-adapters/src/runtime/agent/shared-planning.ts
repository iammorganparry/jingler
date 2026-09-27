import { createHash, randomUUID } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import type { AgentRunSpec, PlannotatorProjection, PlannotatorReviewDecision, StreamEvent } from "@jingler/core"
import { extractProgressMarkers, parseChecklist, updateChecklistStatuses, type ChecklistStatus } from "@jingler/plannotator-ext/generated/checklist.ts"
import { parsePlanMarkdown } from "@jingler/plannotator-ext/plan-parse.ts"
import { validatePlanMarkdown } from "@jingler/plannotator-ext/plan-validation.ts"
import { isPlanWritePathAllowed } from "@jingler/plannotator-ext/tool-scope.ts"
import phaseConfig from "@jingler/plannotator-ext/plannotator.json" with { type: "json" }
import { Effect, Schema, Stream } from "effect"
import { AtomicJsonFile } from "../persistence/atomic-json-file.js"
import { codeReadModes, INTERACTIVE_TOOL_TIMEOUT_MS, ToolError, type ToolRegistry } from "../tools/tool-registry.js"
import { AgentRuntimeError, type AgentRuntimeContext, type AgentRuntimeOwner, type AgentRuntimeShape } from "./agent-runtime.js"
import { executeRegistryTool } from "./registry-tool-bridge.js"

const State = Schema.Struct({
  cwd: Schema.String,
  phase: Schema.Literal("idle", "planning", "executing"),
  path: Schema.NullOr(Schema.String),
  content: Schema.String,
  reviewPending: Schema.Boolean,
  selectedMode: Schema.optional(Schema.Literal(...codeReadModes))
})
type State = typeof State.Type
const storedState = (directory: string, sessionId: string, chatId: string) => new AtomicJsonFile<State | null>({
  file: join(directory, `${createHash("sha256").update(JSON.stringify([sessionId, chatId])).digest("hex")}.json`),
  decode: Schema.decodeUnknownSync(Schema.parseJson(Schema.NullOr(State))), fallback: () => null
})
export const sharedPlanReviewPending = async (directory: string, sessionId: string, chatId: string) =>
  (await storedState(directory, sessionId, chatId).read())?.reviewPending ?? null

const runtimeError = (cause: unknown) => new AgentRuntimeError({ reason: "runtime", message: cause instanceof Error ? cause.message : "Planning failed", cause })
const attempt = <T>(run: () => Promise<T>) => Effect.tryPromise({ try: run, catch: runtimeError })
const sameOwner = (a: AgentRuntimeOwner, b: AgentRuntimeOwner) => a.runtimeId === b.runtimeId && a.endpointId === b.endpointId && a.targetId === b.targetId
const ownerFor = (spec: AgentRunSpec): AgentRuntimeOwner => ({ runtimeId: spec.runtimeId, endpointId: spec.endpointId, targetId: spec.targetCapabilities.targetId })

async function readPlan(cwd: string, path: string): Promise<string> {
  if (!isPlanWritePathAllowed(path, cwd)) throw new ToolError("forbidden", "Plan must be a Markdown file inside the workspace")
  const file = resolve(cwd, path)
  const metadata = await stat(file)
  if (!metadata.isFile() || metadata.size > 512 * 1024) throw new ToolError("invalid-input", "Plan must be a regular file no larger than 512 KiB")
  const content = await readFile(file, "utf8")
  if (!content.trim()) throw new ToolError("invalid-input", "Plan is empty")
  return content
}

async function migratePi(spec: AgentRunSpec, sessionsDir: string): Promise<State | null> {
  if (spec.continuation?.runtimeId !== "pi") return null
  const file = await realpath(spec.continuation.id).catch(() => null)
  if (!file) return null
  const nested = relative(await realpath(sessionsDir), file)
  if (nested.startsWith("..") || isAbsolute(nested)) throw new Error("Pi continuation is outside Jingler session storage")
  const Legacy = Schema.Struct({ phase: State.fields.phase, lastSubmittedPath: Schema.optional(Schema.NullOr(Schema.String)), reviewPending: Schema.optional(Schema.Boolean) })
  const entry = SessionManager.open(file, sessionsDir, spec.cwd).getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "plannotator")
  if (entry?.type === "custom") {
    const previous = Schema.decodeUnknownSync(Legacy)(entry.data)
    const path = previous.lastSubmittedPath ?? null
    return { cwd: await realpath(spec.cwd), phase: previous.phase, path, content: path ? await readPlan(spec.cwd, path) : "", reviewPending: previous.reviewPending ?? false }
  }
  return null
}

const markerUpdates = (text: string): ReadonlyMap<number, ChecklistStatus> => new Map(extractProgressMarkers(text).map((marker) => [
  marker.step, marker.status === "completed" || marker.status === "skipped" ? "completed" : marker.status === "in-progress" ? "in-progress" : "blocked"
]))

interface PendingReview {
  readonly id: string
  readonly resolve: (decision: PlannotatorReviewDecision) => void
  readonly reject: (error: Error) => void
  deciding: boolean
}

class PlanningSession {
  state!: State
  binding: { spec: AgentRunSpec; context: AgentRuntimeContext; signal: AbortSignal } | null = null
  registry: ToolRegistry | null = null
  pending: PendingReview | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private text = ""
  constructor(readonly storage: AtomicJsonFile<State | null>) {}

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  async publish() {
    const state = this.state
    const parsed = state.content ? parsePlanMarkdown(state.content) : null
    const projection: PlannotatorProjection = {
      phase: state.phase, planFilePath: state.path, review: this.pending ? { reviewId: this.pending.id } : null,
      checklist: parseChecklist(state.content), planContent: state.content,
      ...(parsed?.stages.length ? parsed : {})
    }
    if (this.binding) await Effect.runPromise(this.binding.context.publishEvent({ _tag: "PlannotatorStateChanged", state: projection }))
  }

  async save() { await this.storage.write(this.state); await this.publish() }

  instructions() {
    if (this.state.phase === "idle") return "The plan scratchpad is available, but plan mode is off. Earlier planning-phase restrictions no longer apply."
    return phaseConfig.phases[this.state.phase].instructions
      .replaceAll(`\${planFilePath}`, () => this.state.path ?? "a workspace Markdown plan")
      .replaceAll(`\${todoList}`, () => parseChecklist(this.state.content).map((item) => `${item.step}. [${item.completed ? "x" : " "}] ${item.text}`).join("\n"))
  }

  attachRegistry(registry: ToolRegistry) { this.registry = registry }

  register(registry: ToolRegistry, context: AgentRuntimeContext) {
    this.registry = registry
    for (const submit of [false, true]) registry.register({
      id: submit ? "plannotator_submit_plan" : "plannotator_update_plan", version: "1",
      description: submit ? "Submit a workspace Markdown plan for operator review. Waits for approval or revision feedback; never auto-approves." : "Open or refresh the live plan view from a workspace Markdown file without requesting approval.",
      input: Schema.Struct({ filePath: Schema.String.pipe(Schema.minLength(1)) }), risk: "read",
      roles: ["conversation", "plan", "plan-execution"], modes: codeReadModes,
      timeoutMs: INTERACTIVE_TOOL_TIMEOUT_MS, outputBudget: 16_000, cancellable: true, idempotency: "unsafe",
      execute: ({ filePath }, { signal }) => {
        if (!context.planning) throw new ToolError("cancelled", "Planning turn ended")
        return context.planning.execute(filePath, submit, signal)
      }
    })
  }

  async execute(filePath: string, submit: boolean, signal: AbortSignal) {
    if (!this.binding) throw new ToolError("cancelled", "Planning turn ended")
    const combined = AbortSignal.any([signal, this.binding.signal])
    await this.serialize(() => this.adopt(filePath, submit, combined))
    if (submit) return this.review(combined)
    return { message: "Plan view updated without requesting approval.", checklist: parseChecklist(this.state.content) }
  }

  private async adopt(filePath: string, submit: boolean, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.pending || this.state.reviewPending) throw new ToolError("forbidden", "A plan review is pending; resolve or resume it before changing the plan")
    const content = await readPlan(this.state.cwd, filePath)
    const errors = submit ? validatePlanMarkdown(content) : []
    if (errors.length) throw new ToolError("invalid-input", errors.join("\n"))
    this.state = { ...this.state, path: relative(this.state.cwd, resolve(this.state.cwd, filePath)), content,
      ...(submit ? { phase: "planning" as const, reviewPending: true } : {}) }
    await this.save()
  }

  async review(signal: AbortSignal): Promise<{ approved: boolean; feedback?: string; message: string }> {
    if (this.pending) throw new ToolError("forbidden", "A plan review is already active")
    let pending!: PendingReview
    const decision = new Promise<PlannotatorReviewDecision>((resolve, reject) => {
      pending = { id: randomUUID(), resolve, reject, deciding: false }
    })
    // Publication can fail before the waiter is attached; handle abort immediately.
    void decision.catch(() => undefined)
    this.pending = pending
    const abort = () => pending.reject(new ToolError("cancelled", "Plan review interrupted; resume the review before execution"))
    signal.addEventListener("abort", abort, { once: true })
    try {
      if (signal.aborted) abort()
      await this.publish()
      const verdict = await decision
      return { approved: verdict.approved, ...(verdict.feedback ? { feedback: verdict.feedback } : {}),
        message: verdict.approved ? `Plan approved. Continue execution in this session.\n${this.instructions()}` : "Plan rejected. Revise the same file and resubmit for approval." }
    } finally {
      signal.removeEventListener("abort", abort)
      this.pending = null
      await this.publish()
    }
  }

  async decide(owner: AgentRuntimeOwner, decision: PlannotatorReviewDecision) {
    await this.serialize(async () => {
      const pending = this.pending
      if (!this.binding || !sameOwner(ownerFor(this.binding.spec), owner) || !pending || pending.id !== decision.reviewId || pending.deciding) {
        throw new Error("Plan review is stale or belongs to another runtime")
      }
      pending.deciding = true
      try {
        // The UI approves the displayed snapshot, never an unseen concurrent edit.
        if (decision.approved && (!this.state.path || await readPlan(this.state.cwd, this.state.path) !== this.state.content)) {
          throw new Error("Plan changed during review; reject and resubmit the updated file")
        }
        this.state = { ...this.state, phase: decision.approved ? "executing" : "planning", reviewPending: false }
        await this.save()
        pending.resolve(decision)
      } catch (error) { pending.deciding = false; throw error }
    })
  }

  async bind(original: AgentRunSpec, spec: AgentRunSpec, context: AgentRuntimeContext, signal: AbortSignal, piSessionsDir: string) {
    if (this.binding) throw new Error("Planning chat already has an active turn")
    this.binding = { spec, context, signal }
    this.text = ""
    try {
      this.state = await this.storage.read() ?? await migratePi(original, piSessionsDir) ?? {
        cwd: await realpath(spec.cwd), phase: original.mode === "plan" ? "planning" : "idle", path: null, content: "", reviewPending: false
      }
      if (this.state.cwd !== await realpath(spec.cwd)) throw new Error("Plan belongs to a different workspace")
      if (original.mode === "plan" && this.state.selectedMode !== undefined && this.state.selectedMode !== "plan" && !this.state.reviewPending) {
        this.state = { ...this.state, phase: "planning" }
      }
      this.state = { ...this.state, selectedMode: original.mode }
      await this.save()
    } catch (error) { this.binding = null; throw error }
  }

  private async refreshPendingReview() {
      const path = this.state.path
      try {
        if (!path) throw new Error("Plan path is missing")
        this.state = { ...this.state, content: await readPlan(this.state.cwd, path) }
        await this.save()
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT"
        const reason = missing ? `${path} no longer exists.` : error instanceof ToolError && error.message === "Plan is empty" ? `${path} is empty.` : error instanceof Error ? error.message : "Plan is unavailable"
        this.state = { ...this.state, phase: "idle", path: null, content: "", reviewPending: false }
        await this.save()
        throw new Error(`Cannot resume plan review: ${reason}`)
      }
  }

  async prompt(spec: AgentRunSpec, signal: AbortSignal) {
    let prompt = spec.prompt
    if (this.state.reviewPending) {
      await this.refreshPendingReview()
      const result = await this.review(signal)
      prompt = `${result.message}\n${result.feedback ?? ""}\n\n${spec.prompt === "/plannotator-resume-review" ? "Continue with the review outcome." : spec.prompt}`
    }
    return `${prompt}\n\n<jingler-planning>\n${this.instructions()}\n</jingler-planning>`
  }

  async observe(event: StreamEvent) {
    if (event._tag === "Assistant") {
      this.text += event.text
      if (!extractProgressMarkers(this.text).length) return
    } else if (event._tag !== "ToolStart" && event._tag !== "Done") return
    const end = event._tag === "Assistant" ? this.text.lastIndexOf("]") + 1 : this.text.length
    const pending = this.text.slice(0, end)
    this.text = this.text.slice(end)
    await this.serialize(() => this.progress(pending, event._tag === "Done"))
  }

  async progressFailed(error: AgentRuntimeError) {
    await this.serialize(async () => {
      const content = this.state.path ? await readPlan(this.state.cwd, this.state.path).catch(() => null) : null
      this.state = content === null
        ? { ...this.state, phase: "idle", path: null, content: "", reviewPending: false }
        : { ...this.state, content }
      await this.save()
      if (this.binding) await Effect.runPromise(this.binding.context.publishEvent({
        _tag: "Assistant", text: `\nPlan progress could not be saved: ${error.message}\n`
      }))
    })
  }

  private async writeProgress(content: string, next: string) {
    const binding = this.binding!
    if (!this.registry) throw new Error("Planning mutation registry is unavailable")
    const id = randomUUID()
    await Effect.runPromise(binding.context.publishEvent({ _tag: "ToolStart", id, name: "workspace_edit", target: this.state.path }))
    const result = await executeRegistryTool({ registry: this.registry, spec: binding.spec, context: binding.context,
      id: "workspace_edit", toolCallId: id, parameters: { path: this.state.path, oldText: content, newText: next },
      signal: binding.signal, allowed: true, onUpdate: undefined })
    await Effect.runPromise(binding.context.publishEvent({ _tag: "ToolEnd", id, status: result.details.status === "success" ? "success" : "error",
      meta: null, diff: null, preview: result.details.preview, output: result.content.map(({ text }) => text).join("\n"),
      ...(result.details.fileChanges ? { fileChanges: result.details.fileChanges } : {}) }))
    if (result.details.status !== "success") throw new Error(`Could not save plan progress: ${result.content.map(({ text }) => text).join("\n")}`)
  }

  private async progress(text: string, turnEnded: boolean) {
    if (!this.binding || !this.state.path || this.state.reviewPending) return
    const content = await readPlan(this.state.cwd, this.state.path)
    const next = this.state.phase === "planning" ? content : updateChecklistStatuses(content, markerUpdates(text))
    if (next !== content) await this.writeProgress(content, next)
    this.state = { ...this.state, content: await readPlan(this.state.cwd, this.state.path) }
    const checklist = parseChecklist(this.state.content)
    if (turnEnded && this.state.phase === "executing" && checklist.length > 0 && checklist.every((item) => item.completed)) {
      this.state = { ...this.state, phase: "idle" }
    }
    await this.save()
  }

}

/** One owner across harnesses; registries and pending decisions remain run-scoped. */
export const makeSharedPlanningRuntime = (directory: string, piSessionsDir: string) => {
  const sessions = new Map<string, PlanningSession>()
  return (runtime: AgentRuntimeShape): AgentRuntimeShape => ({
    ...runtime,
    decidePlanReview: (owner, sessionId, chatId, decision) => attempt(async () => {
      const session = sessions.get(JSON.stringify([sessionId, chatId]))
      if (!session) throw new Error("Plan review is not active; resume it first")
      await session.decide(owner, decision)
    }),
    run: (original, context) => Stream.unwrapScoped(Effect.gen(function* () {
      if (original.role === "title" || original.role === "context-digest") return runtime.run(original, context)
      const spec = original.mode === "plan" ? { ...original, mode: "auto" as const, role: "conversation" as const } : original
      const key = JSON.stringify([spec.sessionId, spec.chatId])
      const session = sessions.get(key) ?? new PlanningSession(storedState(directory, spec.sessionId, spec.chatId))
      sessions.set(key, session)
      const controller = new AbortController()
      yield* Effect.acquireRelease(
        attempt(() => session.bind(original, spec, context, controller.signal, piSessionsDir)),
        () => Effect.promise(async () => {
          controller.abort()
          await session.serialize(async () => { session.binding = null; session.registry = null })
          sessions.delete(key)
        })
      )
      const prompt = yield* attempt(() => session.prompt(spec, controller.signal))
      const planningContext: AgentRuntimeContext = { ...context, isPlanReviewPending: () => session.pending !== null, planning: session }
      // Pi normalizes parent execution itself; preserve its original child capability ceiling.
      return runtime.run({ ...(original.runtimeId === "pi" ? original : spec), prompt }, planningContext).pipe(Stream.tap((event) =>
        attempt(() => session.observe(event)).pipe(Effect.catchAll((error) => attempt(() => session.progressFailed(error))))
      ))
    }))
  })
}

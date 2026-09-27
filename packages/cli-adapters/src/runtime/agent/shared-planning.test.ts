import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_RUNTIME_CONTRACTS, nativeCliEndpointId, ProviderModelId, type AgentRunSpec, type AgentRuntimeId, type PlannotatorProjection, type StreamEvent } from "@jingler/core"
import { Effect, Fiber, Schema, Stream } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { inactiveRuntimeActivity, type AgentRuntimeContext, type AgentRuntimeShape } from "./agent-runtime.js"
import { makeClaudeAgentRuntime } from "./claude-agent-runtime.js"
import { createJinglerControlTools } from "./pi-jingler-tools.js"
import { executeRegistryTool } from "./registry-tool-bridge.js"
import { makeSharedPlanningRuntime, sharedPlanReviewPending } from "./shared-planning.js"
import { ToolRegistry } from "../tools/tool-registry.js"
import { childExecutionProfile } from "../subagents/subagent-capability-broker.js"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const done: StreamEvent = { _tag: "Done", tokens: 0, costUsd: 0 }
const specFor = (cwd: string, runtimeId: AgentRuntimeId = "claude"): AgentRunSpec => ({
  runId: "r", sessionId: "s", chatId: "a", runtimeId, endpointId: nativeCliEndpointId("desktop", runtimeId === "pi" ? "claude" : runtimeId),
  modelId: ProviderModelId.make("anthropic/haiku"), role: "conversation", mode: "auto", cwd, prompt: "hello", priorMessages: [], continuation: null, seed: null,
  targetCapabilities: { targetId: "desktop", versions: CURRENT_RUNTIME_CONTRACTS, toolIds: [], resourceIds: [] }
})
const ownerFor = (spec: AgentRunSpec) => ({ runtimeId: spec.runtimeId, endpointId: spec.endpointId, targetId: spec.targetCapabilities.targetId })
type Script = (registry: ToolRegistry, spec: AgentRunSpec, context: AgentRuntimeContext) => AsyncGenerator<StreamEvent>
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-shared-planning-")); roots.push(root)
  await writeFile(join(root, "plan.md"), "# Work\n- [ ] first $&\n- [ ] second\n")
  const events: StreamEvent[] = []
  const permitted = vi.fn(() => Effect.succeed("allow" as const))
  const observed = vi.fn(() => Effect.succeed({ cwd: root, tree: "before" }))
  const context: AgentRuntimeContext = { ...inactiveRuntimeActivity, canUseTool: permitted, askQuestion: () => Effect.succeed([]),
    publishEvent: (event) => Effect.sync(() => { events.push(event) }) }
  const wrap = (script: Script) => makeSharedPlanningRuntime(join(root, "state"), root)({
    ...makeClaudeAgentRuntime(),
    run: (spec, bound) => Stream.fromAsyncIterable({ async *[Symbol.asyncIterator]() {
      const registry = createJinglerControlTools(bound, new ToolRegistry({ observer: {
        started: observed, settled: () => Effect.succeed({ id: "changes", callId: "call", changes: [], totals: { added: 0, removed: 0 }, authoritative: true, reconciledAt: new Date().toISOString() })
      } }))
      registry.register({ id: "workspace_edit", version: "1", description: "edit", input: Schema.Struct({ path: Schema.String, oldText: Schema.String, newText: Schema.String }), risk: "mutate", roles: ["conversation"], modes: ["auto", "ask"], timeoutMs: 10_000, outputBudget: 1000, cancellable: true, idempotency: "safe",
        execute: async ({ path, oldText, newText }) => {
          const current = await readFile(join(root, path), "utf8")
          if (current !== oldText) throw new Error("Concurrent file edit")
          await writeFile(join(root, path), newText)
        } })
      yield* script(registry, spec, bound)
    } }, (cause) => { throw cause })
  })
  const run = (runtime: AgentRuntimeShape, spec = specFor(root)) => Effect.runPromise(Stream.runCollect(runtime.run(spec, context)))
  const projections = () => events.flatMap((event) => event._tag === "PlannotatorStateChanged" ? [event.state] : [])
  const review = async () => { let state: PlannotatorProjection | undefined; await vi.waitFor(() => {
    state = projections().at(-1); expect(state?.review).not.toBeNull(); expect(state?.review).toBeDefined()
  }); return state!.review!.reviewId }
  return { root, context, events, permitted, observed, wrap, run, projections, review }
}
const call = (registry: ToolRegistry, spec: AgentRunSpec, context: AgentRuntimeContext, id: string, parameters: unknown, signal?: AbortSignal) => executeRegistryTool({
  registry, spec, context, id, parameters, signal, allowed: true, toolCallId: crypto.randomUUID(), onUpdate: undefined
})

describe("shared harness planning", () => {
  it.each(["pi", "claude", "codex", "opencode"] as const)("%s opens the plan, awaits operator review, and persists tracked marker progress", async (runtimeId) => {
    const f = await setup()
    const spec = specFor(f.root, runtimeId)
    let approved = false
    const runtime = f.wrap(async function* (registry, spec, context) {
      expect(registry.capabilitiesFor(spec.role, spec.mode).map(({ id }) => id)).toEqual(expect.arrayContaining(["plannotator_update_plan", "plannotator_submit_plan"]))
      expect((await call(registry, spec, context, "plannotator_update_plan", { filePath: "plan.md" })).details.status).toBe("success")
      const result = await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" })
      expect(result.details.value).toMatchObject({ approved: true })
      approved = true
      yield { _tag: "Assistant", text: "[ACT" }; yield { _tag: "Assistant", text: "IVE:1]" }
      yield { _tag: "Assistant", text: "[DONE:1] [DONE:2]" }
      yield done
    })
    const running = f.run(runtime, spec)
    const reviewId = await f.review()
    expect(approved).toBe(false)
    expect(f.projections().at(-1)?.planFilePath).toBe("plan.md")
    await Effect.runPromise(runtime.decidePlanReview(ownerFor(spec), spec.sessionId, spec.chatId, { reviewId, approved: true }))
    await running
    expect(await readFile(join(f.root, "plan.md"), "utf8")).toContain("- [x] first $&")
    expect(f.permitted).toHaveBeenCalledWith({ toolId: "workspace_edit", risk: "mutate" })
    expect(f.observed).toHaveBeenCalledTimes(2)
    expect(f.events).toContainEqual(expect.objectContaining({ _tag: "ToolEnd", fileChanges: expect.objectContaining({ id: "changes" }) }))
    expect(f.projections().at(-1)).toMatchObject({ phase: "idle", review: null, checklist: [{ completed: true }, { completed: true }] })
    await expect(Effect.runPromise(runtime.decidePlanReview(ownerFor(spec), "s", "a", { reviewId, approved: true }))).rejects.toThrow("not active")
  })

  it("rejects foreign/stale decisions and concurrent updates; changed disk content cannot be approved", async () => {
    const f = await setup(); const spec = specFor(f.root)
    let registry!: ToolRegistry; let bound!: AgentRuntimeContext
    const runtime = f.wrap(async function* (tools, spec, context) {
      registry = tools; bound = context
      const result = await call(tools, spec, context, "plannotator_submit_plan", { filePath: "plan.md" })
      expect(result.details.value).toMatchObject({ approved: false, feedback: "Revise" })
      yield done
    })
    const running = f.run(runtime)
    const reviewId = await f.review()
    const verdict = { reviewId, approved: true }
    await expect(Effect.runPromise(runtime.decidePlanReview({ ...ownerFor(spec), targetId: "other" }, "s", "a", verdict))).rejects.toThrow("another runtime")
    expect((await call(registry, spec, bound, "plannotator_update_plan", { filePath: "plan.md" })).details.status).toBe("error")
    await writeFile(join(f.root, "plan.md"), "# Changed\n- [ ] other\n")
    await expect(Effect.runPromise(runtime.decidePlanReview(ownerFor(spec), "s", "a", verdict))).rejects.toThrow("changed during review")
    expect(f.projections().at(-1)?.planContent).toContain("first")
    await Effect.runPromise(runtime.decidePlanReview(ownerFor(spec), "s", "a", { reviewId, approved: false, feedback: "Revise" }))
    await running
    expect(f.projections().at(-1)?.phase).toBe("planning")
  })

  it("publishes the previously reviewed text only when a resubmission changed it", async () => {
    const f = await setup(); const spec = specFor(f.root)
    const runtime = f.wrap(async function* (registry, spec, context) {
      await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" })
      await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" })
      await writeFile(join(f.root, "plan.md"), "# Work\n- [ ] first revised\n")
      await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" })
      yield done
    })
    const running = f.run(runtime)
    const decide = async (approved: boolean) => {
      const reviewId = await f.review()
      const published = f.projections().at(-1)
      await Effect.runPromise(runtime.decidePlanReview(ownerFor(spec), "s", "a", { reviewId, approved, ...(approved ? {} : { feedback: "Revise" }) }))
      await vi.waitFor(() => expect(f.projections().at(-1)?.review).toBeNull())
      return published
    }
    expect((await decide(false))?.previousPlanContent).toBeUndefined()
    // Unchanged resubmission: nothing to compare against.
    expect((await decide(false))?.previousPlanContent).toBeUndefined()
    const revised = await decide(true)
    expect(revised?.planContent).toBe("# Work\n- [ ] first revised\n")
    expect(revised?.previousPlanContent).toBe("# Work\n- [ ] first $&\n- [ ] second\n")
    await running
  })

  it("cancels a pending call without approval and recovers with a fresh review ID after restart/harness change", async () => {
    const f = await setup(); const controller = new AbortController()
    const first = f.wrap(async function* (registry, spec, context) {
      const result = await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" }, controller.signal)
      expect(result.details.status).toBe("cancelled")
      yield done
    })
    const running = f.run(first); const previous = await f.review()
    controller.abort(); await running
    expect(await sharedPlanReviewPending(join(f.root, "state"), "s", "a")).toBe(true)
    let launched = false
    const next = f.wrap(async function* (_registry, spec) { launched = true; expect(spec.prompt).toContain("Plan approved"); yield done })
    const input = { ...specFor(f.root, "codex"), prompt: "/plannotator-resume-review" }
    const resumed = f.run(next, input); const reviewId = await f.review()
    expect(reviewId).not.toBe(previous); expect(launched).toBe(false)
    await Effect.runPromise(next.decidePlanReview(ownerFor(input), "s", "a", { reviewId, approved: true }))
    await resumed
    expect(await sharedPlanReviewPending(join(f.root, "state"), "s", "a")).toBe(false)
  })

  it("isolates chat plans and denies progress writes in read-only mode", async () => {
    const f = await setup()
    const runtime = f.wrap(async function* (registry, spec, context) {
      await call(registry, spec, context, "plannotator_update_plan", { filePath: "plan.md" })
      yield { _tag: "Assistant", text: "[DONE:1]" }; yield done
    })
    await f.run(runtime, { ...specFor(f.root), mode: "read-only" })
    expect(await readFile(join(f.root, "plan.md"), "utf8")).toContain("- [ ] first")
    expect(f.events).toContainEqual(expect.objectContaining({ _tag: "Assistant", text: expect.stringContaining("Could not save plan progress") }))
    const another = f.wrap(async function* () { yield done })
    await f.run(another, { ...specFor(f.root), chatId: "other" })
    expect(f.projections().at(-1)?.planFilePath).toBeNull()
  })

  it("rejects escaping symlinks on adoption and again before marker writes", async () => {
    const f = await setup()
    const outside = await mkdtemp(join(tmpdir(), "jingler-plan-outside-")); roots.push(outside)
    await writeFile(join(outside, "other.md"), "- [ ] untouched")
    await symlink(join(outside, "other.md"), join(f.root, "escape.md"))
    const runtime = f.wrap(async function* (registry, spec, context) {
      expect((await call(registry, spec, context, "plannotator_update_plan", { filePath: "escape.md" })).details.status).toBe("error")
      await call(registry, spec, context, "plannotator_update_plan", { filePath: "plan.md" })
      await rm(join(f.root, "plan.md")); await symlink(join(outside, "other.md"), join(f.root, "plan.md"))
      yield { _tag: "Assistant", text: "[DONE:1]" }; yield done
    })
    await f.run(runtime)
    expect(await readFile(join(outside, "other.md"), "utf8")).toBe("- [ ] untouched")
    expect(f.observed).not.toHaveBeenCalled()
  })

  it("interrupts review recovery without launching a harness", async () => {
    const f = await setup(); const controller = new AbortController()
    const runtime = f.wrap(async function* (registry, spec, context) {
      await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" }, controller.signal)
      yield done
    })
    const running = f.run(runtime); await f.review(); controller.abort(); await running
    const next = f.wrap(async function* () { expect.fail("Must not launch during pending review"); yield done })
    const fiber = Effect.runFork(Stream.runDrain(next.run(specFor(f.root), f.context)))
    await f.review()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(await sharedPlanReviewPending(join(f.root, "state"), "s", "a")).toBe(true)
  })
  it("serializes marker mutations behind concurrent tool mutations using the same observer", async () => {
    const f = await setup()
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    let started = false
    let executing = false
    let overlap = false
    f.observed.mockImplementation(() => {
      if (executing) overlap = true
      return Effect.succeed({ cwd: f.root, tree: "before" })
    })
    const runtime = f.wrap(async function* (registry, spec, context) {
      await call(registry, spec, context, "plannotator_update_plan", { filePath: "plan.md" })
      registry.register({ id: "other_mutation", version: "1", description: "mutate", input: Schema.Struct({}), risk: "mutate", roles: ["conversation"], modes: ["auto"], timeoutMs: 10000, outputBudget: 1000, cancellable: true, idempotency: "safe",
        execute: async () => { executing = true; started = true; await blocked; executing = false } })
      const mutation = call(registry, spec, context, "other_mutation", {})
      await vi.waitFor(() => expect(started).toBe(true))
      yield { _tag: "Assistant", text: "[DONE:1]" }
      await mutation
      yield done
    })
    const running = f.run(runtime)
    await vi.waitFor(() => expect(started).toBe(true))
    expect(f.observed).toHaveBeenCalledTimes(1)
    finish(); await running
    expect(overlap).toBe(false)
    expect(f.observed).toHaveBeenCalledTimes(2)
    expect(await readFile(join(f.root, "plan.md"), "utf8")).toContain("- [x] first")
  })

  it("migrates a legacy Pi plan without visible history and preserves it on later native turns", async () => {
    const f = await setup(); const file = join(f.root, "legacy.jsonl")
    await writeFile(file, [
      { type: "session", version: 3, id: "legacy", cwd: f.root, timestamp: new Date().toISOString() },
      { type: "custom", id: "plan", parentId: null, customType: "plannotator", data: { phase: "executing", lastSubmittedPath: "plan.md" }, timestamp: new Date().toISOString() }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    const first = specFor(f.root, "pi")
    const input = { ...first, continuation: { runtimeId: "pi" as const, endpointId: first.endpointId, id: file } }
    const runtime = f.wrap(async function* (_registry, spec) { expect(spec.prompt).toContain("EXECUTING PLAN"); yield done })
    await f.run(runtime, input)
    expect(f.projections().at(-1)).toMatchObject({ phase: "executing", planFilePath: "plan.md" })
    const next = f.wrap(async function* (_registry, spec) { expect(spec.prompt).toContain("EXECUTING PLAN"); yield done })
    await f.run(next, specFor(f.root, "opencode"))
    expect(f.projections().at(-1)?.phase).toBe("executing")
  })

  it("keeps a retained Pi tool bound to the current turn and permission callbacks", async () => {
    const f = await setup(); let retained: ToolRegistry | undefined; let turns = 0
    let activeContext: AgentRuntimeContext
    const facade = { ...f.context, get planning() { return activeContext.planning } }
    const runtime = f.wrap(async function* (registry, spec, context) {
      activeContext = context
      retained ??= createJinglerControlTools(facade)
      context.planning?.attachRegistry(registry)
      turns++
      expect((await call(retained, spec, context, "plannotator_update_plan", { filePath: "plan.md" })).details.status).toBe("success")
      yield { _tag: "Assistant", text: `[DONE:${turns}]` }; yield done
    })
    await f.run(runtime, specFor(f.root, "pi"))
    const nextEvents: StreamEvent[] = []
    const nextContext = { ...f.context, publishEvent: (event: StreamEvent) => Effect.sync(() => { nextEvents.push(event) }) }
    await Effect.runPromise(Stream.runDrain(runtime.run(specFor(f.root, "pi"), nextContext)))
    expect(nextEvents).toContainEqual(expect.objectContaining({ _tag: "PlannotatorStateChanged", state: expect.objectContaining({ checklist: [{ step: 1, text: "first $&", completed: true }, { step: 2, text: "second", completed: true }] }) }))
  })

  it("enters planning when an existing chat switches modes without resetting approved plan turns", async () => {
    const f = await setup(); let turn = 0
    const runtime = f.wrap(async function* (registry, spec, context) {
      turn++
      if (turn === 2) {
        expect(spec.prompt).toContain("PLANNING PHASE")
        await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" })
      }
      if (turn === 3) expect(spec.prompt).toContain("EXECUTING PLAN")
      yield done
    })
    await f.run(runtime)
    const input = { ...specFor(f.root), mode: "plan" as const }
    const running = f.run(runtime, input)
    const reviewId = await f.review()
    await Effect.runPromise(runtime.decidePlanReview(ownerFor(input), "s", "a", { reviewId, approved: true }))
    await running
    await f.run(runtime, input)
    expect(f.projections().at(-1)?.phase).toBe("executing")
  })

  it("preserves Pi child plan permissions while the parent retains planning tools", async () => {
    const f = await setup()
    const runtime = f.wrap(async function* (registry, spec, context) {
      expect(childExecutionProfile(spec, "worker")).toEqual({ role: "plan", mode: "plan" })
      const result = await call(registry, spec, context, "plannotator_update_plan", { filePath: "plan.md" })
      expect(result.details.status).toBe("success")
      yield done
    })
    await f.run(runtime, { ...specFor(f.root, "pi"), role: "plan", mode: "plan" })
  })

  it("distinguishes absent shared review state from a settled migrated review", async () => {
    const f = await setup()
    expect(await sharedPlanReviewPending(join(f.root, "state"), "s", "a")).toBeNull()
    const file = join(f.root, "legacy.jsonl")
    await writeFile(file, [
      { type: "session", version: 3, id: "legacy", cwd: f.root, timestamp: new Date().toISOString() },
      { type: "custom", id: "plan", parentId: null, customType: "plannotator", data: { phase: "planning", lastSubmittedPath: "plan.md", reviewPending: true }, timestamp: new Date().toISOString() }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    const input = specFor(f.root, "pi")
    const runtime = f.wrap(async function* () { yield done })
    const running = f.run(runtime, { ...input, continuation: { runtimeId: "pi", endpointId: input.endpointId, id: file } })
    const reviewId = await f.review()
    await Effect.runPromise(runtime.decidePlanReview(ownerFor(input), "s", "a", { reviewId, approved: true }))
    await running
    expect(await sharedPlanReviewPending(join(f.root, "state"), "s", "a")).toBe(false)
    expect(await readFile(file, "utf8")).toContain('"reviewPending":true')
  })

  it.each(["missing", "empty"])("clears an interrupted review whose file becomes %s before restart", async (condition) => {
    const f = await setup(); const controller = new AbortController()
    const runtime = f.wrap(async function* (registry, spec, context) {
      await call(registry, spec, context, "plannotator_submit_plan", { filePath: "plan.md" }, controller.signal)
      yield done
    })
    const running = f.run(runtime); await f.review(); controller.abort(); await running
    if (condition === "missing") await rm(join(f.root, "plan.md"))
    else await writeFile(join(f.root, "plan.md"), "")
    const next = f.wrap(async function* () { expect.fail("Invalid recovery must not launch the harness"); yield done })
    await expect(f.run(next)).rejects.toThrow(`Cannot resume plan review: plan.md ${condition === "missing" ? "no longer exists." : "is empty."}`)
    expect(await sharedPlanReviewPending(join(f.root, "state"), "s", "a")).toBe(false)
    expect(f.projections().at(-1)).toMatchObject({ phase: "idle", planFilePath: null, checklist: [] })
  })

  it("clears stale progress after file deletion without terminating the model turn", async () => {
    const f = await setup()
    const runtime = f.wrap(async function* (registry, spec, context) {
      await call(registry, spec, context, "plannotator_update_plan", { filePath: "plan.md" })
      await rm(join(f.root, "plan.md"))
      yield { _tag: "Assistant", text: "[DONE:1]" }
      yield { _tag: "Assistant", text: "Turn continued" }
      yield done
    })
    const output = await f.run(runtime)
    expect([...output]).toContainEqual({ _tag: "Assistant", text: "Turn continued" })
    expect(f.events.some((event) => event._tag === "Failed")).toBe(false)
    expect(f.projections().at(-1)).toMatchObject({ planFilePath: null, checklist: [] })
  })

})

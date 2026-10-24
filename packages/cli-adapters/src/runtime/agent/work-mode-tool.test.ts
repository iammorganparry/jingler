import { Effect } from "effect"
import type { StreamEvent } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import { createJinglerControlTools } from "./pi-jingler-tools.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"
import { MAX_WORK_MODE_SWITCHES, registerWorkModeTool } from "./work-mode-tool.js"

const setup = (opts: { approved?: boolean; auto?: boolean; role?: "conversation" | "plan"; mode?: "plan" | "auto" } = {}) => {
  const events: StreamEvent[] = []
  let switches = 0
  const context = {
    publishEvent: (e: StreamEvent) => Effect.sync(() => { events.push(e) }),
    planning: { planApproved: () => opts.approved === true },
    workModeHost: {
      approvalIsAuto: () => opts.auto === true,
      reserveSwitch: () => switches < MAX_WORK_MODE_SWITCHES && ++switches > 0
    }
  } as unknown as AgentRuntimeContext
  const registry = new ToolRegistry()
  registerWorkModeTool(registry, context)
  const run = (mode: "plan" | "build") =>
    Effect.runPromise(registry.execute({
      id: "jingler_set_work_mode", arguments: { mode, reason: "r" },
      role: opts.role ?? "conversation", mode: opts.mode ?? "auto"
    }))
  return { events, run }
}

describe("jingler_set_work_mode", () => {
  it("plan always allowed", async () => {
    const { events, run } = setup({ role: "plan", mode: "plan" })
    expect((await run("plan")).status).toBe("success")
    expect(events).toEqual([{ _tag: "WorkModeChanged", workMode: "plan" }])
  })

  it("build needs approved plan", async () => {
    const { events, run } = setup()
    const result = await run("build")
    expect(result.status).toBe("error")
    expect(result.error?.message).toContain("plannotator_submit_plan")
    expect(events).toEqual([])
    expect((await setup({ approved: true }).run("build")).status).toBe("success")
  })

  it("auto approval allows build", async () => {
    expect((await setup({ auto: true }).run("build")).status).toBe("success")
  })

  it("rate limited per turn", async () => {
    const { run } = setup({ auto: true })
    expect((await run("plan")).status).toBe("success")
    expect((await run("build")).status).toBe("success")
    expect((await run("plan")).status).toBe("error")
  })

  it("not registered without autoSwitch", () => {
    const ctx = { publishEvent: () => Effect.void, registerBackgroundStop: () => Effect.void, canUseTool: () => Effect.succeed("allow"), askQuestion: () => Effect.succeed([]) } as unknown as AgentRuntimeContext
    const ids = createJinglerControlTools(ctx).capabilitiesFor("conversation", "auto").map((c) => c.id)
    expect(ids).not.toContain("jingler_set_work_mode")
    const on = createJinglerControlTools({ ...ctx, workModeHost: { approvalIsAuto: () => false, reserveSwitch: () => true } })
    expect(on.capabilitiesFor("conversation", "plan").map((c) => c.id)).toContain("jingler_set_work_mode")
  })
})

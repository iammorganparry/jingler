import type { Message, Plan } from "@jingler/core"
import { applyStreamEvent, assistantMessage, latestPlan, userMessage } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"

// The module graph reaches `rpc-client`, whose protocol layer binds `window` at
// import — undefined under node. These are pure-function tests that never touch
// the rpc, so a bare stub keeps that binding from running.
vi.mock("./rpc-client.js", () => ({ rpc: {} }))

import {
  LIVE_HISTORY_CAP,
  shouldTrimLiveHistory,
  trimmedTailState
} from "./conversation-machine.js"

const TS = "2026-01-01T00:00:00.000Z"

const plan = (id: string): Plan =>
  ({
    id,
    summary: "Live plan",
    structured: true,
    graph: null,
    comments: [],
    status: "proposed",
    raw: "<h1>PRD</h1>",
    steps: []
  }) as unknown as Plan

const user = (id: string): Message => userMessage(id, "hi", TS)
const planMessage = (id: string, p: Plan): Message =>
  applyStreamEvent(assistantMessage(id, TS), { _tag: "PlanProposed", plan: p })

describe("shouldTrimLiveHistory", () => {
  it("trips only strictly above the cap", () => {
    expect(shouldTrimLiveHistory(LIVE_HISTORY_CAP)).toBe(false)
    expect(shouldTrimLiveHistory(LIVE_HISTORY_CAP - 1)).toBe(false)
    expect(shouldTrimLiveHistory(LIVE_HISTORY_CAP + 1)).toBe(true)
  })

  it("honours an explicit cap", () => {
    expect(shouldTrimLiveHistory(3, 2)).toBe(true)
    expect(shouldTrimLiveHistory(2, 2)).toBe(false)
  })
})

describe("trimmedTailState", () => {
  it("passes the disk tail's hasMore and cursor straight through", () => {
    const state = trimmedTailState([user("d_1"), user("d_2")], true, "v1:400", null)
    expect(state.hasMoreHistory).toBe(true)
    expect(state.historyCursor).toBe("v1:400")
    expect(state.messages.map((m) => m.id)).toEqual(["d_1", "d_2"])
  })

  it("leaves a null cursor null (the oldest page)", () => {
    const state = trimmedTailState([user("d_1")], false, null, null)
    expect(state.hasMoreHistory).toBe(false)
    expect(state.historyCursor).toBeNull()
  })

  it("grafts the shared plan onto its own message when the tail still holds it", () => {
    const p = plan("plan_1")
    const tail = [user("d_1"), planMessage("d_plan", p)]
    const state = trimmedTailState(tail, true, "v1:100", p)
    // No synthetic card is appended — the plan is already in the window.
    expect(state.messages.map((m) => m.id)).toEqual(["d_1", "d_plan"])
    expect(latestPlan(state.messages)?.id).toBe("plan_1")
  })

  it("re-appends a synthetic plan card when the plan's message was trimmed out", () => {
    // The plan was proposed hundreds of turns back, so it is not in the re-read
    // tail — but `sharedPlan` still carries it, so the inline bubble survives.
    const p = plan("plan_1")
    const tail = [user("d_1"), user("d_2")]
    const state = trimmedTailState(tail, true, "v1:100", p)
    expect(state.messages).toHaveLength(3)
    const last = state.messages[state.messages.length - 1]!
    expect(last.id.startsWith("a_shared_plan_")).toBe(true)
    expect(last.streaming).toBe(false)
    expect(latestPlan(state.messages)?.id).toBe("plan_1")
  })
})

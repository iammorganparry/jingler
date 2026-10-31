// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Message, ToolCall } from "@jingler/core"
import { agentCommandTabs, closeAgentCommand, findToolCall, markDone, mirrorWrite, watchAgentCommand } from "./agent-command-tabs.js"

const tool = (id: string, output: string): ToolCall => ({
  id, name: "command_execute", target: "pnpm test", status: "running", meta: null, diff: null, preview: null, output
})
const message = (...tools: ToolCall[]): Message =>
  ({ parts: tools.map((t) => ({ _tag: "Tool", tool: t })) }) as unknown as Message

describe("mirrorWrite", () => {
  it("appends only the new tail of a growing snapshot", () => {
    expect(mirrorWrite("hel", "hello")).toEqual({ reset: false, data: "lo" })
  })
  it("redraws when the snapshot was trimmed or replaced", () => {
    expect(mirrorWrite("abcdef", "cdefgh")).toEqual({ reset: true, data: "cdefgh" })
  })
})

describe("findToolCall", () => {
  it("finds a call in the main transcript or a sub-agent's", () => {
    const context = {
      messages: [message(tool("a", "main"))],
      subagents: [{ message: message(tool("b", "child")) }]
    } as never
    expect(findToolCall(context, "a")?.output).toBe("main")
    expect(findToolCall(context, "b")?.output).toBe("child")
    expect(findToolCall(context, "missing")).toBeUndefined()
  })
})

describe("agent command tabs", () => {
  it("reuses one tab per tool call, marks it done, and closes it", () => {
    const id = watchAgentCommand("s1", "c1", "t1", "pnpm vitest run --reporter verbose src")
    expect(watchAgentCommand("s1", "c1", "t1", "pnpm vitest")).toBe(id)
    expect(agentCommandTabs("s1")).toHaveLength(1)
    expect(agentCommandTabs("s1")[0]!.title).toBe("pnpm vitest run --reporter…")
    expect(agentCommandTabs("s2")).toEqual([])
    markDone("s1", id)
    expect(agentCommandTabs("s1")[0]!.done).toBe(true)
    closeAgentCommand("s1", id)
    expect(agentCommandTabs("s1")).toEqual([])
  })
})

// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Message, ToolCall } from "@jingler/core"
import { agentCommandTabs, clearAgentCommands, closeAgentCommand, findToolCall, markDone, mirrorWrite, watchAgentCommand } from "./agent-command-tabs.js"

const tool = (id: string, output: string): ToolCall => ({
  id, name: "command_execute", target: "pnpm test", status: "running", meta: null, diff: null, preview: null, output
})
const message = (...tools: ToolCall[]): Message =>
  ({ parts: tools.map((t) => ({ _tag: "Tool", tool: t })) }) as unknown as Message

describe("mirrorWrite", () => {
  it("appends only the new tail of a growing live snapshot", () => {
    expect(mirrorWrite("hel", "hello", true)).toEqual({ reset: false, data: "lo" })
  })
  it("redraws when a live snapshot was trimmed", () => {
    expect(mirrorWrite("abcdef", "cdefgh", true)).toEqual({ reset: true, data: "cdefgh" })
  })
  it("keeps watched output when the settled result differs (stderr-only error)", () => {
    expect(mirrorWrite("FAIL src/a.test.ts\n", "warning: deprecated", false)).toBeNull()
  })
  it("never clears on missing output (compacted or trimmed)", () => {
    expect(mirrorWrite("watched", undefined, true)).toBeNull()
    expect(mirrorWrite("watched", undefined, false)).toBeNull()
  })
  it("shows the settled output when nothing was watched live", () => {
    expect(mirrorWrite("", "1 passed", false)).toEqual({ reset: false, data: "1 passed" })
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

describe("clearAgentCommands", () => {
  it("drops one chat's mirrors, then the whole session", () => {
    watchAgentCommand("s3", "c1", "t1", "pnpm test")
    watchAgentCommand("s3", "c2", "t2", "pnpm lint")
    clearAgentCommands("s3", "c1")
    expect(agentCommandTabs("s3").map((t) => t.chatId)).toEqual(["c2"])
    clearAgentCommands("s3")
    expect(agentCommandTabs("s3")).toEqual([])
  })
})

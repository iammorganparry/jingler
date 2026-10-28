import { describe, expect, it, vi } from "vitest"
import { publishSubagentProgress } from "./pi-session-factory.js"

const redacted = (type: "tool_execution_update" | "tool_execution_end", toolCallId: string) =>
  ({
    type,
    toolCallId,
    toolName: "subagent",
    ...(type === "tool_execution_end" ? { result: undefined } : {}),
    [type === "tool_execution_end" ? "result" : "partialResult"]: {
      details: {
        mode: "single",
        runId: "run-1",
        asyncId: "async-1",
        progress: [{ index: 0, agent: "worker", status: "running", task: "[prompt redacted]", tokens: 0, toolCount: 0, durationMs: 1 }],
        results: []
      }
    },
    isError: false
  }) as never

describe("publishSubagentProgress", () => {
  it("keeps the real task for async progress after tool_execution_end", () => {
    const progress = vi.fn()
    const lifecycle = { progress, attention: vi.fn() } as never
    const tasks = new Map([["call-1", "Review checkout"]])
    publishSubagentProgress(redacted("tool_execution_end", "call-1"), tasks, lifecycle, () => {})
    publishSubagentProgress(redacted("tool_execution_update", "call-2"), tasks, lifecycle, () => {})
    expect(progress.mock.calls.map(([p]) => p.children[0].task)).toEqual(["Review checkout", "Review checkout"])
  })
})

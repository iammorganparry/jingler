import { describe, expect, it } from "vitest"
import {
  agentMessageDelta,
  codexAppServerMessageToStreamEvents,
  completedAgentReply,
  completedTurn,
  makeCodexAppServerEventState
} from "./codex-app-server-events.js"

describe("codex app-server event mapping", () => {
  it("emits authoritative live resident-context usage", () => {
    expect(
      codexAppServerMessageToStreamEvents(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "t1",
            turnId: "turn-1",
            tokenUsage: {
              total: { totalTokens: 900_000 },
              last: { totalTokens: 193_496 },
              modelContextWindow: 258_400
            }
          }
        },
        "t1",
        makeCodexAppServerEventState()
      )
    ).toStrictEqual([{ _tag: "Usage", tokens: 193_496, window: 258_400 }])
  })

  it("streams command output as cumulative snapshots and settles the card", () => {
    const state = makeCodexAppServerEventState()
    const start = codexAppServerMessageToStreamEvents(
      {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: "c1",
            command: "pnpm test",
            status: "inProgress"
          }
        }
      },
      "t1",
      state
    )
    const first = codexAppServerMessageToStreamEvents(
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "c1", delta: "RUN\n" }
      },
      "t1",
      state
    )
    const second = codexAppServerMessageToStreamEvents(
      {
        method: "item/commandExecution/outputDelta",
        params: { itemId: "c1", delta: "PASS\n" }
      },
      "t1",
      state
    )
    const end = codexAppServerMessageToStreamEvents(
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            id: "c1",
            command: "pnpm test",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "RUN\nPASS\n"
          }
        }
      },
      "t1",
      state
    )

    expect(start).toStrictEqual([
      { _tag: "ToolStart", id: "c1", name: "Bash", target: "pnpm test" }
    ])
    expect(first).toStrictEqual([{ _tag: "ToolDelta", id: "c1", output: "RUN\n" }])
    expect(second).toStrictEqual([{ _tag: "ToolDelta", id: "c1", output: "RUN\nPASS\n" }])
    expect(end).toStrictEqual([
      {
        _tag: "ToolEnd",
        id: "c1",
        status: "success",
        meta: "exit 0",
        diff: null,
        preview: null,
        output: "RUN\nPASS\n"
      }
    ])
  })

  it("bounds accumulated output so a flood of deltas cannot exhaust the heap", () => {
    const state = makeCodexAppServerEventState()
    let last: readonly { output?: string }[] = []
    // 200 deltas of 1 MB each — the raw concatenation would retain 200 MB.
    for (let i = 0; i < 200; i++) {
      last = codexAppServerMessageToStreamEvents(
        {
          method: "item/commandExecution/outputDelta",
          params: { itemId: "c1", delta: "q".repeat(1024 * 1024) }
        },
        "t1",
        state
      ) as readonly { output?: string }[]
    }
    const output = last[0]?.output ?? ""
    expect(output.length).toBeLessThan(7_000)
    expect(output).toContain("characters omitted")
  })

  it("maps completed update and create diffs to an edit-card preview", () => {
    const state = makeCodexAppServerEventState()
    const events = codexAppServerMessageToStreamEvents(
      {
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "f1",
            status: "completed",
            changes: [
              {
                path: "src/a.ts",
                kind: "update",
                diff: [
                  "diff --git a/src/a.ts b/src/a.ts",
                  "--- a/src/a.ts",
                  "+++ b/src/a.ts",
                  "@@ -1 +1 @@",
                  "-export const oldName = true",
                  "+export const newName = true"
                ].join("\n")
              },
              {
                path: "src/new.ts",
                kind: "add",
                diff: [
                  "diff --git a/src/new.ts b/src/new.ts",
                  "--- /dev/null",
                  "+++ b/src/new.ts",
                  "@@ -0,0 +1,2 @@",
                  "+export const answer = 42",
                  "+export const ready = true"
                ].join("\n")
              }
            ]
          }
        }
      },
      "t1",
      state
    )

    expect(events).toStrictEqual([
      { _tag: "ToolStart", id: "f1", name: "Edit", target: "src/a.ts" },
      {
        _tag: "ToolEnd",
        id: "f1",
        status: "success",
        meta: "2 files",
        diff: { added: 3, removed: 1 },
        preview: [
          "-export const oldName = true",
          "+export const newName = true",
          " ",
          "+export const answer = 42",
          "+export const ready = true"
        ].join("\n")
      }
    ])
  })

  it("keeps the legacy null preview when a completed file change has no diff", () => {
    expect(
      codexAppServerMessageToStreamEvents(
        {
          method: "item/completed",
          params: {
            item: {
              type: "fileChange",
              id: "f1",
              status: "completed",
              changes: [{ path: "src/a.ts", kind: "update" }]
            }
          }
        },
        "t1",
        makeCodexAppServerEventState()
      )
    ).toStrictEqual([
      { _tag: "ToolStart", id: "f1", name: "Edit", target: "src/a.ts" },
      {
        _tag: "ToolEnd",
        id: "f1",
        status: "success",
        meta: "1 file",
        diff: null,
        preview: null
      }
    ])
  })

  it("holds agent deltas and emits the completed text for interception", () => {
    const state = makeCodexAppServerEventState()
    const delta = codexAppServerMessageToStreamEvents(
      {
        method: "item/agentMessage/delta",
        params: { itemId: "m1", delta: "hello" }
      },
      "t1",
      state
    )
    const completed = {
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "m1", text: "hello" } }
    }
    expect(delta).toStrictEqual([])
    expect(codexAppServerMessageToStreamEvents(completed, "t1", state)).toStrictEqual([
      { _tag: "Assistant", text: "hello" }
    ])
    expect(
      agentMessageDelta({
        method: "item/agentMessage/delta",
        params: { itemId: "m1", delta: "hello" }
      })
    ).toBe("hello")
    expect(completedAgentReply(completed)).toBe("hello")
  })

  it("decodes a failed terminal turn", () => {
    expect(
      completedTurn(
        {
          method: "turn/completed",
          params: {
            threadId: "t1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "context exhausted" }
            }
          }
        },
        "t1"
      )
    ).toStrictEqual({
      turnId: "turn-1",
      status: "failed",
      error: "context exhausted"
    })
  })

  it("does not fail the Jingler turn for an error Codex will retry", () => {
    expect(
      codexAppServerMessageToStreamEvents(
        {
          method: "error",
          params: {
            willRetry: true,
            error: { message: "temporary connection loss" }
          }
        },
        "t1",
        makeCodexAppServerEventState()
      )
    ).toStrictEqual([])
  })
})

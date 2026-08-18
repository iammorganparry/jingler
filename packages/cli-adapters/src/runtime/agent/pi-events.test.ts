import { describe, expect, it } from "vitest"
import {
  createPiEventNormalizer,
  normalizePiEvent,
  piProviderFailure,
  piSubagentProgress,
  piSupervisorAttention
} from "./pi-events.js"

describe("pi event normalization", () => {
  it("normalizes streamed text and tool lifecycle", () => {
    expect(
      normalizePiEvent({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", delta: "hello" } as never
      })
    ).toEqual({ _tag: "Assistant", text: "hello" })
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "workspace.read",
        args: { path: "src/read.ts" }
      })
    ).toMatchObject({
      _tag: "ToolStart",
      id: "call-1",
      name: "workspace.read",
      target: "src/read.ts"
    })
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "workspace.read",
        result: { content: [{ type: "text", text: "result" }] },
        isError: false
      })
    ).toMatchObject({
      _tag: "ToolEnd",
      id: "call-1",
      status: "success",
      output: "result"
    })
  })

  it("holds provider failures outside the stream until pi settles", () => {
    expect(
      piProviderFailure({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { errorMessage: "rate limited" }
        } as never
      })
    ).toBe("rate limited")

    expect(
      piProviderFailure({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0
            }
          },
          stopReason: "error",
          errorMessage: "invalid provider tool schema",
          timestamp: 0
        }
      })
    ).toBe("invalid provider tool schema")
  })

  it("includes the resolved model context window in usage", () => {
    expect(
      normalizePiEvent(
        {
          type: "message_end",
          message: {
            role: "assistant",
            usage: { totalTokens: 42_100 }
          } as never
        },
        128_000
      )
    ).toEqual({ _tag: "Usage", tokens: 42_100, window: 128_000 })
  })

  it("derives bounded file targets from schema-validated tool arguments", () => {
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: "rename-1",
        toolName: "workspace_rename",
        args: { from: "src/old.ts", to: "src/new.ts", ignored: "secret" }
      })
    ).toMatchObject({ target: "src/old.ts → src/new.ts" })
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: "invalid-1",
        toolName: "workspace_read_file",
        args: { path: 42 }
      })
    ).toMatchObject({ target: null })
  })
})

describe("createPiEventNormalizer", () => {
  const thinkingEvent = (update: { type: string; delta?: string }) => ({
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: update as never
  }) as never

  it("times a reasoning run from first delta to end", () => {
    let clock = 1_000
    const normalize = createPiEventNormalizer(() => clock)
    expect(normalize(thinkingEvent({ type: "thinking_delta", delta: "a" })))
      .toEqual({ _tag: "Thinking", text: "a", seconds: null, done: false })
    clock = 13_400
    expect(normalize(thinkingEvent({ type: "thinking_end" })))
      .toEqual({ _tag: "Thinking", text: "", seconds: 12, done: true })
  })

  it("times each chained reasoning run independently and floors at one second", () => {
    let clock = 0
    const normalize = createPiEventNormalizer(() => clock)
    normalize(thinkingEvent({ type: "thinking_delta", delta: "a" }))
    clock = 200
    expect(normalize(thinkingEvent({ type: "thinking_end" })))
      .toMatchObject({ seconds: 1, done: true })
    clock = 5_000
    normalize(thinkingEvent({ type: "thinking_delta", delta: "b" }))
    clock = 8_000
    expect(normalize(thinkingEvent({ type: "thinking_end" })))
      .toMatchObject({ seconds: 3, done: true })
  })

  it("leaves an end without a run to the stateless projection", () => {
    const normalize = createPiEventNormalizer(() => 0)
    expect(normalize(thinkingEvent({ type: "thinking_end" })))
      .toEqual({ _tag: "Thinking", text: "", seconds: null, done: true })
  })
})

describe("pi retry and compaction events", () => {
  it("normalizes retry and compaction lifecycle", () => {
    expect(
      normalizePiEvent({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        errorMessage: "rate limited"
      })
    ).toEqual({
      _tag: "RetryScheduled",
      operation: "provider",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      message: "rate limited"
    })
    expect(
      normalizePiEvent({
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "redacted from the event",
          firstKeptEntryId: "entry-1",
          tokensBefore: 9_000,
          estimatedTokensAfter: 3_000
        },
        aborted: false,
        willRetry: false
      })
    ).toEqual({
      _tag: "CompactionFinished",
      reason: "threshold",
      status: "success",
      tokensBefore: 9_000,
      tokensAfter: 3_000,
      message: null
    })
  })
})

describe("pi file-change events", () => {
  it("normalizes authoritative file-change evidence from tool details", () => {
    const fileChanges = {
      id: "set-1",
      callId: "call-1",
      changes: [
        {
          status: "A",
          path: "src/new.ts",
          oldPath: null,
          added: 2,
          removed: 0,
          binary: false,
          noNewlineAtEnd: false,
          beforeBytes: null,
          afterBytes: 10,
          preview: "+new",
          patchArtifactId: "artifact-1"
        }
      ],
      totals: { added: 2, removed: 0 },
      authoritative: true,
      reconciledAt: "2026-08-10T00:00:00.000Z"
    }
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "workspace.write",
        result: { content: [], details: { fileChanges } },
        isError: false
      })
    ).toMatchObject({
      _tag: "ToolEnd",
      diff: { added: 2, removed: 0 },
      preview: "+new",
      fileChanges
    })
  })

  it("projects live child progress from native subagent tool updates", () => {
    expect(piSubagentProgress({
      type: "tool_execution_update",
      toolCallId: "subagent-call",
      toolName: "subagent",
      args: { agent: "worker" },
      partialResult: {
        content: [],
        details: {
          mode: "single",
          runId: "run-1",
          results: [{
            index: 0,
            runId: "child-run-1",
            sessionFile: "/sessions/child.jsonl"
          }],
          progress: [{
            index: 0,
            agent: "worker",
            status: "running",
            task: "Inspect",
            currentTool: "workspace_read_file",
            model: "test/model",
            inputTokens: 3,
            outputTokens: 2,
            tokens: 5,
            toolCount: 1,
            durationMs: 20
          }]
        }
      }
    })).toEqual({
      runId: "run-1",
      mode: "single",
      settled: false,
      children: [expect.objectContaining({
        index: 0,
        runId: "child-run-1",
        currentTool: "workspace_read_file",
        sessionFile: "/sessions/child.jsonl"
      })]
    })
  })

  it("projects an async spawn acknowledgment that carries no progress array", () => {
    // Real pi-subagents async output: `{mode, runId, asyncId, asyncDir,
    // results: []}` — no `progress` key. This must decode to an empty-children
    // report so the lifecycle adapter can still project a running root node.
    expect(piSubagentProgress({
      type: "tool_execution_end",
      toolCallId: "subagent-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "Async: scout [run-async-1]" }],
        details: {
          mode: "workflow",
          runId: "run-async-1",
          asyncId: "run-async-1",
          asyncDir: "/tmp/async-subagent-runs/run-async-1",
          results: []
        }
      },
      isError: false
    } as never)).toEqual({
      runId: "run-async-1",
      mode: "workflow",
      // An async acknowledgment never settles the run: it detached and lives on.
      settled: false,
      children: []
    })
  })

  it("projects workflow children from the live call trace when no progress array exists", () => {
    // A scripted workflow's live-card updates carry `workflow.trace` and an
    // empty `results` — the trace is the ONLY live per-child signal. Dropping
    // it left the Fleet with a lone workflow container and nothing to select.
    expect(piSubagentProgress({
      type: "tool_execution_update",
      toolCallId: "subagent-call",
      toolName: "subagent",
      args: {},
      partialResult: {
        content: [{ type: "text", text: "Workflow running." }],
        details: {
          mode: "workflow",
          runId: "wf-1",
          results: [],
          workflow: {
            trace: [
              { operation: "run", key: "main", state: "running" },
              { operation: "run", key: "main", state: "running", runId: "child-1" }
            ]
          }
        }
      }
    } as never)).toEqual({
      runId: "wf-1",
      mode: "workflow",
      settled: false,
      children: [expect.objectContaining({
        index: 0,
        runId: "child-1",
        agent: "main",
        status: "running",
        sessionFile: null
      })]
    })
  })

  it("projects completed workflow children from the final results when no progress array exists", () => {
    // The foreground workflow's terminal tool result carries children only as
    // `results` (with agent/task/sessionFile). Registering them here is what
    // makes each step's transcript openable after the run.
    expect(piSubagentProgress({
      type: "tool_execution_end",
      toolCallId: "subagent-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "Workflow completed." }],
        details: {
          mode: "workflow",
          runId: "wf-1",
          results: [{
            index: 0,
            runId: "child-1",
            agent: "reviewer",
            task: "Review the diff",
            sessionFile: "/sessions/child-1.jsonl"
          }, {
            index: 1,
            runId: "child-2",
            agent: "builder",
            error: "budget exceeded"
          }]
        }
      },
      isError: false
    } as never)).toEqual({
      runId: "wf-1",
      mode: "workflow",
      settled: true,
      children: [
        expect.objectContaining({
          index: 0,
          runId: "child-1",
          agent: "reviewer",
          status: "completed",
          task: "Review the diff",
          sessionFile: "/sessions/child-1.jsonl"
        }),
        expect.objectContaining({
          index: 1,
          runId: "child-2",
          agent: "builder",
          status: "failed",
          error: "budget exceeded"
        })
      ]
    })
  })

  it("merges settled results into trace-derived children by runId", () => {
    expect(piSubagentProgress({
      type: "tool_execution_end",
      toolCallId: "subagent-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "Workflow completed." }],
        details: {
          mode: "workflow",
          runId: "wf-1",
          results: [{
            index: 0,
            runId: "child-1",
            agent: "reviewer",
            sessionFile: "/sessions/child-1.jsonl"
          }],
          workflow: {
            trace: [
              { operation: "run", key: "main", state: "running", runId: "child-1" },
              { operation: "run", key: "main", state: "complete", runId: "child-1", durationMs: 1200 }
            ]
          }
        }
      },
      isError: false
    } as never)).toEqual({
      runId: "wf-1",
      mode: "workflow",
      settled: true,
      children: [expect.objectContaining({
        runId: "child-1",
        agent: "reviewer",
        status: "completed",
        durationMs: 1200,
        sessionFile: "/sessions/child-1.jsonl"
      })]
    })
  })

  it("ignores management replies that carry no runId", () => {
    expect(piSubagentProgress({
      type: "tool_execution_end",
      toolCallId: "subagent-call",
      toolName: "subagent",
      result: {
        content: [],
        details: { mode: "management", results: [] }
      },
      isError: false
    } as never)).toBeNull()
  })

  it("projects exact supervisor attention from native custom messages", () => {
    expect(piSupervisorAttention({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent_supervisor_request",
        content: "Choose an API",
        display: true,
        details: {
          id: "attention-1",
          reason: "need_decision",
          expectsReply: true,
          runId: "run-1",
          agent: "worker",
          childIndex: 0
        },
        timestamp: 1
      }
    })).toEqual({
      requestId: "attention-1",
      reason: "need_decision",
      message: "Choose an API",
      runId: "run-1",
      agent: "worker",
      childIndex: 0,
      requestedAt: 1,
      deadlineAt: null
    })
  })

  it("keeps valid diff evidence when unrelated result content is malformed", () => {
    const fileChanges = {
      id: "set-2",
      callId: "call-2",
      changes: [],
      totals: { added: 0, removed: 0 },
      authoritative: true,
      reconciledAt: "2026-08-10T00:00:00.000Z"
    }
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "workspace.write",
        result: { content: "invalid", details: { fileChanges } },
        isError: false
      })
    ).toMatchObject({ _tag: "ToolEnd", fileChanges })
  })
})

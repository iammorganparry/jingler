import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent"
import type { SubagentFleetEvent } from "@jingler/core"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  cleanAgentLabel,
  cleanTaskLabel,
  PiSubagentLifecycleAdapter
} from "./pi-subagent-lifecycle-adapter.js"

describe("fleet identity cleanup", () => {
  it("keeps genuine agent and workflow names, relabelling only bare collapse tokens", () => {
    expect(cleanAgentLabel("scout")).toBe("scout")
    expect(cleanAgentLabel("reviewer")).toBe("reviewer")
    // A descriptive workflow key is a real name — keep it.
    expect(cleanAgentLabel("review-followup")).toBe("review-followup")
    // The pi vendor collapses an unresolved child onto a bare mode/key.
    expect(cleanAgentLabel("main")).toBe("Subagent")
    expect(cleanAgentLabel("single")).toBe("Subagent")
    expect(cleanAgentLabel("workflow")).toBe("Subagent")
  })

  it("strips the vendor's 'run <key>' task noise but keeps a real task", () => {
    expect(cleanTaskLabel("run main")).toBe("Active delegated work")
    expect(cleanTaskLabel("run review-followup")).toBe("Active delegated work")
    expect(cleanTaskLabel(undefined)).toBe("Active delegated work")
    expect(cleanTaskLabel("")).toBe("Active delegated work")
    expect(cleanTaskLabel("Map the signals pipeline")).toBe("Map the signals pipeline")
  })
})

const parent = "parent-session"
const parentSessionFile = "/sessions/parent.jsonl"

describe("PiSubagentLifecycleAdapter", () => {
  it("projects async and nested completion events with stable transcript identities", () => {
    const events = createEventBus()
    const emitted: SubagentFleetEvent[] = []
    let now = 10
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      parentPiSessionAliases: [parentSessionFile],
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => now
    })
    adapter.start()
    events.emit("subagent:async-started", {
      lifecycleArtifactVersion: 3,
      id: "run-1",
      sessionId: parentSessionFile,
      agent: "fanout",
      goal: "Coordinate review"
    })
    events.emit("subagent:async-started", {
      lifecycleArtifactVersion: 3,
      id: "run-2",
      sessionId: parent,
      agent: "scout",
      goal: "Inspect one branch",
      parentWorkflowRunId: "run-1"
    })
    now = 20
    events.emit("subagent:async-complete", {
      runId: "run-1",
      sessionId: parentSessionFile,
      state: "complete",
      success: true,
      results: [{
        index: 0,
        agent: "reviewer",
        success: true,
        sessionPath: "/sessions/reviewer.jsonl",
        artifactPath: "/artifacts/review.md",
        model: "anthropic/claude-test:high",
        usage: {
          input: 12,
          output: 8,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.02,
          turns: 2
        }
      }, {
        index: 1,
        agent: "worker",
        success: true,
        sessionPath: "/sessions/worker.jsonl",
        model: "anthropic/claude-test:high"
      }]
    })

    expect(adapter.snapshot().nodes).toEqual([
      expect.objectContaining({
        id: `${parent}/run-2`,
        parentId: null,
        agent: "scout",
        status: "running"
      })
    ])
    const upserts = emitted.filter((event) => event._tag === "Upsert")
    expect(upserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: expect.objectContaining({
          subagentId: "run-1:step:0",
          sessionFile: "/sessions/reviewer.jsonl",
          artifacts: [expect.objectContaining({ path: "/artifacts/review.md" })]
        })
      })
    ]))
    expect(upserts).toHaveLength(6)
    expect(emitted.filter(({ _tag }) => _tag === "Remove")).toHaveLength(3)
    adapter.stop()
  })

  it("keeps one direct child identity through steering, completion, and transcript", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pi-completed-transcript-"))
    const manager = SessionManager.create(process.cwd(), root)
    manager.appendMessage({ role: "user", content: "Inspect", timestamp: 1 })
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 2
    })
    const sessionFile = manager.getSessionFile()
    if (!sessionFile) throw new Error("Expected a child session file")
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      trustedSessionRoots: [root],
      controlJournal: null,
      emit: () => undefined,
      now: () => 10
    })
    adapter.start()
    let steeredRunId = ""
    const unsubscribe = events.on("subagents:rpc:v1:request", (request) => {
      if (!request || typeof request !== "object" ||
        !("requestId" in request) || !("method" in request) || !("params" in request) ||
        typeof request.requestId !== "string" || request.method !== "steer" ||
        !request.params || typeof request.params !== "object" || !("runId" in request.params) ||
        typeof request.params.runId !== "string") return
      steeredRunId = request.params.runId
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        method: "steer",
        success: true,
        data: {
          details: {
            steering: {
              requestId: "native-direct-steer",
              deliveryStatus: "delivered"
            }
          }
        }
      })
    })
    try {
      adapter.progress({
        runId: "run-1",
        mode: "single",
        children: [{
          index: 0,
          runId: "child-run",
          agent: "worker",
          status: "running",
          task: "Inspect",
          tokens: 2,
          toolCount: 1,
          durationMs: 10,
          sessionFile
        }]
      })
      expect(adapter.snapshot().nodes).toEqual([
        expect.objectContaining({
          subagentId: "child-run",
          runId: "child-run",
          nodeKind: "agent",
          parentId: null,
          sessionFile
        })
      ])
      await expect(adapter.control({
        version: 2,
        requestId: "direct-steer",
        parentPiSessionId: parent,
        runId: "child-run",
        action: "steer",
        message: "Check the edge case",
        replyTo: null
      })).resolves.toMatchObject({
        acknowledged: true,
        runId: "child-run",
        deliveryStatus: "delivered",
        nativeRequestId: "native-direct-steer"
      })
      expect(steeredRunId).toBe("child-run")

      events.emit("subagent:async-complete", {
        runId: "run-1",
        sessionId: parent,
        state: "complete",
        success: true,
        results: [{
          index: 0,
          runId: "child-run",
          agent: "worker",
          success: true,
          sessionFile
        }]
      })

      expect(adapter.snapshot().nodes).toEqual([])
      adapter.stop()
      await expect(adapter.transcript("child-run")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({
          role: "user",
          parts: [{ _tag: "Text", text: "Inspect" }]
        })])
      )
    } finally {
      unsubscribe()
      adapter.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reconciles bounded RPC fleet status and ignores malformed or foreign events", async () => {
    const events = createEventBus()
    const emitted: SubagentFleetEvent[] = []
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 50
    })
    adapter.start()
    events.emit("subagent:async-started", { id: 12 })
    events.emit("subagent:async-started", {
      id: "foreign",
      sessionId: "other",
      agent: "worker"
    })
    const unsubscribe = events.on("subagents:rpc:v1:request", (request) => {
      if (!request || typeof request !== "object" || !("requestId" in request)) return
      const requestId = request.requestId
      if (typeof requestId !== "string") return
      events.emit(`subagents:rpc:v1:reply:${requestId}`, {
        version: 1,
        requestId,
        method: "status",
        success: true,
        data: {
          fleet: {
            version: 1,
            entries: [{
              key: "active-1",
              agent: "scout",
              model: "anthropic/claude-test:low",
              startedAt: 40,
              tokens: { input: 3, output: 2, total: 5 },
              goal: "Inspect"
            }],
            totalActive: 1,
            topLevelAsyncCapacity: { used: 1, limit: 4 },
            omitted: 0
          }
        }
      })
    })

    const snapshot = await adapter.refresh()

    expect(snapshot.nodes).toMatchObject([{
      id: `${parent}/active-1`,
      agent: "scout",
      status: "running",
      usage: { totalTokens: 5 }
    }])
    expect(emitted).toHaveLength(1)
    unsubscribe()
    adapter.stop()
  })

  it("publishes one direct child with no redundant root", () => {
    const events = createEventBus()
    const emitted: SubagentFleetEvent[] = []
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 50
    })
    adapter.start()
    events.emit("subagent:async-started", {
      id: "run-1",
      sessionId: parent,
      mode: "single",
      agent: "worker"
    })

    adapter.progress({
      runId: "run-1",
      mode: "single",
      children: [{
        index: 0,
        runId: null,
        agent: "worker",
        status: "running",
        task: "Inspect",
        currentTool: "workspace_read_file",
        model: "test/model",
        inputTokens: 3,
        outputTokens: 2,
        tokens: 5,
        toolCount: 1,
        durationMs: 20,
        sessionFile: "/sessions/child.jsonl"
      }]
    })

    expect(adapter.snapshot().nodes).toEqual([
      expect.objectContaining({
        subagentId: "run-1:step:0",
        runId: "run-1:step:0",
        nodeKind: "agent",
        parentId: null,
        currentTool: "workspace_read_file",
        sessionFile: "/sessions/child.jsonl",
        usage: expect.objectContaining({ totalTokens: 5, toolCalls: 1 })
      })
    ])
    expect(adapter.supervisorSnapshot()).toMatchObject({
      status: "running",
      siblings: [expect.objectContaining({
        subagentId: "run-1:step:0",
        outputAvailable: true
      })]
    })
    for (let toolCount = 2; toolCount <= 260; toolCount++) {
      adapter.progress({
        runId: "run-1",
        mode: "single",
        children: [{
          index: 0,
          runId: null,
          agent: "worker",
          status: "running",
          task: "Inspect",
          tokens: toolCount,
          toolCount,
          durationMs: toolCount,
          sessionFile: "/sessions/child.jsonl"
        }]
      })
    }
    const replay = adapter.replay(0)
    expect(replay).toHaveLength(256)
    expect(new Set(replay.map(({ eventId }) => eventId)).size).toBe(256)
    expect(emitted.some((event) =>
      event._tag === "Upsert" && event.node.currentTool === "workspace_read_file"
    )).toBe(true)
    adapter.stop()
  })

  it("projects a running root from an async acknowledgment with no children", () => {
    // An async spawn's tool result reports only `{mode, runId}` — the work
    // detached before any per-child progress existed. The Fleet must still
    // gain a node even when the `subagent:async-started` bus event is missed.
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: () => undefined,
      now: () => 60
    })
    adapter.start()
    adapter.progress({ runId: "run-async", mode: "workflow", children: [] })
    expect(adapter.snapshot().nodes).toEqual([
      expect.objectContaining({
        runId: "run-async",
        nodeKind: "workflow",
        status: "running",
        background: true
      })
    ])

    // A stale trailing acknowledgment must not resurrect a settled run.
    events.emit("subagent:async-complete", {
      runId: "run-async",
      sessionId: parent,
      status: "complete",
      timestamp: 61
    })
    const settled = adapter.snapshot().nodes.find((node) => node.runId === "run-async")
    adapter.progress({ runId: "run-async", mode: "workflow", children: [] })
    expect(adapter.snapshot().nodes.find((node) => node.runId === "run-async"))
      .toEqual(settled)
    adapter.stop()
  })

  it("keeps a genuine workflow container and canonical children visible", () => {
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: () => undefined,
      now: () => 50
    })
    adapter.start()
    adapter.progress({ runId: "workflow-run", mode: "workflow", children: [] })
    adapter.progress({
      runId: "workflow-run",
      mode: "workflow",
      children: [{
        index: 0,
        runId: "canonical-child-a",
        agent: "worker",
        status: "running",
        task: "Inspect A",
        tokens: 0,
        toolCount: 0,
        durationMs: 1,
        sessionFile: "/sessions/child-a.jsonl"
      }, {
        index: 1,
        runId: "canonical-child-b",
        agent: "reviewer",
        status: "running",
        task: "Inspect B",
        tokens: 0,
        toolCount: 0,
        durationMs: 1,
        sessionFile: "/sessions/child-b.jsonl"
      }]
    })
    const snapshot = adapter.snapshot()
    expect(snapshot.nodes).toHaveLength(3)
    const workflow = snapshot.nodes.find((node) => node.nodeKind === "workflow")
    expect(workflow).toMatchObject({
      subagentId: "workflow-run",
      runId: "workflow-run",
      parentId: null,
      sessionFile: null
    })
    expect(snapshot.nodes.filter((node) => node.nodeKind === "agent")).toEqual([
      expect.objectContaining({
        subagentId: "canonical-child-a",
        runId: "canonical-child-a",
        parentId: workflow?.id,
        sessionFile: "/sessions/child-a.jsonl"
      }),
      expect.objectContaining({
        subagentId: "canonical-child-b",
        runId: "canonical-child-b",
        parentId: workflow?.id,
        sessionFile: "/sessions/child-b.jsonl"
      })
    ])

    events.emit("subagent:async-complete", {
      runId: "workflow-run",
      sessionId: parent,
      state: "complete",
      success: true,
      results: [{
        index: 0,
        runId: "canonical-child-a",
        agent: "worker",
        success: true
      }, {
        index: 1,
        runId: "canonical-child-b",
        agent: "reviewer",
        success: true
      }]
    })

    expect(adapter.snapshot().nodes).toEqual([])
    adapter.stop()
  })

  it("returns factual acknowledgements for exact lifecycle controls", async () => {
    const events = createEventBus()
    const methods: string[] = []
    const requestIds: string[] = []
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: () => undefined,
      now: () => 30
    })
    adapter.start()
    const unsubscribe = events.on("subagents:rpc:v1:request", (request) => {
      if (!request || typeof request !== "object" || !("requestId" in request) || !("method" in request)) return
      if (typeof request.requestId !== "string" || typeof request.method !== "string") return
      methods.push(request.method)
      requestIds.push(request.requestId)
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, request.method === "stop"
        ? {
            version: 1,
            requestId: request.requestId,
            method: request.method,
            success: false,
            error: { code: "invalid_state", message: "Run is complete" }
          }
        : {
            version: 1,
            requestId: request.requestId,
            method: request.method,
            success: true,
            data: request.method === "steer"
              ? {
                  details: {
                    steering: {
                      requestId: "native-steer-1",
                      deliveryStatus: "queued"
                    }
                  }
                }
              : { delivered: true }
          })
    })
    const base = {
      version: 2 as const,
      parentPiSessionId: parent,
      runId: "run-1",
      replyTo: null
    }

    adapter.attention({
      requestId: "attention-1",
      runId: "run-1",
      childIndex: 0,
      agent: "worker",
      reason: "need_decision",
      message: "Choose an API",
      requestedAt: 25,
      deadlineAt: null
    })
    expect(adapter.snapshot().nodes[0]?.status).toBe("needs-attention")
    const steerRequest = {
      ...base,
      requestId: "steer-1",
      action: "steer" as const,
      message: "Check tests"
    }
    const steer = await adapter.control(steerRequest)
    expect(steer).toMatchObject({
      acknowledged: true,
      status: "accepted",
      deliveryStatus: "queued",
      sequence: 1,
      nativeRequestId: "native-steer-1"
    })
    await expect(adapter.control(steerRequest)).resolves.toEqual(steer)
    await expect(adapter.control({
      ...base,
      requestId: "wrong-reply",
      runId: "other-run",
      action: "reply",
      message: "Wrong child",
      replyTo: "attention-1"
    })).resolves.toMatchObject({
      acknowledged: false,
      status: "not-found",
      deliveryStatus: "rejected"
    })
    await expect(adapter.control({
      ...base,
      requestId: "reply-1",
      action: "reply",
      message: "Use the public API",
      replyTo: "attention-1"
    })).resolves.toMatchObject({ acknowledged: true, status: "accepted" })
    expect(adapter.snapshot().nodes[0]).toMatchObject({
      status: "running",
      attention: null
    })
    await expect(adapter.control({
      ...base,
      requestId: "stop-1",
      action: "stop",
      message: null
    })).resolves.toMatchObject({ acknowledged: false, status: "invalid-state" })
    expect(methods).toEqual(["steer", "reply", "stop"])
    expect(requestIds).toEqual(["steer-1", "reply-1", "stop-1"])
    unsubscribe()
    adapter.stop()
  })

  it("settles a delivered control deterministically across child completion", async () => {
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: () => undefined,
      now: () => 40
    })
    adapter.start()
    events.emit("subagent:async-started", {
      id: "race-run",
      sessionId: parent,
      agent: "worker"
    })
    let rpcRequestId = ""
    const unsubscribe = events.on("subagents:rpc:v1:request", (request) => {
      if (request && typeof request === "object" && "requestId" in request &&
        typeof request.requestId === "string") rpcRequestId = request.requestId
    })
    const control = adapter.control({
      version: 2,
      requestId: "race-control",
      parentPiSessionId: parent,
      runId: "race-run",
      action: "steer",
      message: "Finish safely",
      replyTo: null
    })
    await vi.waitFor(() => expect(rpcRequestId).toBe("race-control"))
    events.emit("subagent:async-complete", {
      runId: "race-run",
      sessionId: parent,
      state: "complete",
      success: true
    })
    events.emit(`subagents:rpc:v1:reply:${rpcRequestId}`, {
      version: 1,
      requestId: rpcRequestId,
      method: "steer",
      success: true,
      data: {
        details: {
          steering: {
            requestId: "native-race",
            deliveryStatus: "delivered"
          }
        }
      }
    })

    await expect(control).resolves.toMatchObject({
      acknowledged: true,
      deliveryStatus: "delivered",
      nativeRequestId: "native-race"
    })
    expect(adapter.snapshot().nodes).toEqual([])
    unsubscribe()
    adapter.stop()
  })

  it("clears completed durable nodes before a failed RPC fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-stale-fleet-"))
    const marker = join(root, ".active-runs", "run-1")
    await mkdir(join(root, ".active-runs"), { recursive: true })
    await mkdir(join(root, "run-1"), { recursive: true })
    await writeFile(marker, "")
    await writeFile(join(root, "run-1", "status.json"), JSON.stringify({
      runId: "run-1",
      sessionId: parentSessionFile,
      state: "running",
      mode: "workflow",
      startedAt: 10,
      lastUpdate: 20
    }))
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      parentPiSessionAliases: [parentSessionFile],
      asyncRunsDir: root,
      controlJournal: null,
      emit: () => undefined,
      now: () => 30
    })
    adapter.start()
    try {
      await adapter.refresh()
      expect(adapter.snapshot().nodes).toHaveLength(1)
      await rm(marker)
      const unsubscribe = events.on("subagents:rpc:v1:request", (request) => {
        if (!request || typeof request !== "object" || !("requestId" in request)) return
        events.emit(`subagents:rpc:v1:reply:${String(request.requestId)}`, {})
      })
      await expect(adapter.refresh()).resolves.toMatchObject({ nodes: [] })
      expect(adapter.snapshot().nodes).toStrictEqual([])
      unsubscribe()
    } finally {
      adapter.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("settles and REMOVES an observed process instead of leaving it in the dock", () => {
    const emitted: SubagentFleetEvent[] = []
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 20
    })
    adapter.start()
    events.emit("subagent:async-started", {
      id: "run-1",
      sessionId: parent,
      agent: "worker"
    })
    events.emit("subagent:process-terminal", {
      runId: "run-1",
      state: "observed",
      observedAt: 20
    })

    // The settled state is still PUBLISHED (so completion retention sees it)…
    expect(emitted.some((event) =>
      event._tag === "Upsert" &&
      event.node.runId === "run-1" &&
      event.node.status === "unknown" &&
      event.node.completedAt === 20
    )).toBe(true)
    // …but the dead run does not linger as a grey UNKNOWN row: its process is
    // gone, so no event will ever settle or revive it.
    expect(adapter.snapshot().nodes).toEqual([])
    adapter.stop()
  })

  it("settles a terminal workflow root as completed when every child finished", async () => {
    // A workflow root's completion results are keyed to child run ids, so the
    // root itself is never settled by them — its process ending used to decay
    // a still-"running" root to "unknown" even with every step finished.
    const root = await mkdtemp(join(tmpdir(), "jingler-workflow-terminal-"))
    await mkdir(join(root, ".active-runs"), { recursive: true })
    await mkdir(join(root, "wf-1"), { recursive: true })
    await writeFile(join(root, ".active-runs", "wf-1"), "")
    await writeFile(join(root, "wf-1", "status.json"), JSON.stringify({
      runId: "wf-1",
      sessionId: parentSessionFile,
      state: "running",
      mode: "workflow",
      startedAt: 10,
      steps: [{
        runId: "child-run",
        agent: "scout",
        status: "completed",
        startedAt: 11,
        sessionFile: "/sessions/child.jsonl"
      }]
    }))
    const emitted: SubagentFleetEvent[] = []
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      parentPiSessionAliases: [parentSessionFile],
      asyncRunsDir: root,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 30
    })
    adapter.start()
    try {
      await adapter.refresh()
      events.emit("subagent:process-terminal", {
        runId: "wf-1",
        state: "observed",
        observedAt: 30
      })
      // Settled as completed (not decayed to unknown) — published for the
      // retention pass — and then removed along with its children.
      expect(emitted.some((event) =>
        event._tag === "Upsert" &&
        event.node.nodeKind === "workflow" &&
        event.node.status === "completed" &&
        event.node.completedAt === 30
      )).toBe(true)
      expect(adapter.snapshot().nodes.filter(
        (node) => node.nodeKind === "workflow" || node.orchestrationRunId === "wf-1"
      )).toEqual([])
    } finally {
      adapter.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects unowned missing-session events but accepts correlated completion", () => {
    const events = createEventBus()
    const emitted: SubagentFleetEvent[] = []
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 20
    })
    adapter.start()
    events.emit("subagent:async-started", { id: "unowned", agent: "scout" })
    events.emit("subagent:async-complete", {
      runId: "unowned",
      state: "complete",
      success: true
    })
    expect(adapter.snapshot().nodes).toEqual([])

    events.emit("subagent:async-started", {
      id: "owned",
      sessionId: parent,
      agent: "scout"
    })
    events.emit("subagent:async-complete", {
      runId: "owned",
      state: "complete",
      success: true
    })
    expect(adapter.snapshot().nodes).toEqual([])
    expect(emitted.some((event) =>
      event._tag === "Upsert" &&
      event.node.subagentId === "owned" &&
      event.node.status === "completed"
    )).toBe(true)
    adapter.stop()
  })

  it("keeps one canonical child identity across durable and completion state", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-canonical-fleet-"))
    const emitted: SubagentFleetEvent[] = []
    const marker = join(root, ".active-runs", "run-1")
    await mkdir(join(root, ".active-runs"), { recursive: true })
    await mkdir(join(root, "run-1"), { recursive: true })
    await writeFile(marker, "")
    await writeFile(join(root, "run-1", "status.json"), JSON.stringify({
      runId: "run-1",
      sessionId: parentSessionFile,
      state: "running",
      mode: "workflow",
      startedAt: 10,
      steps: [{
        runId: "child-run",
        agent: "scout",
        status: "running",
        startedAt: 11
      }]
    }))
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      parentPiSessionAliases: [parentSessionFile],
      asyncRunsDir: root,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 30
    })
    adapter.start()
    try {
      const refreshing = adapter.refresh()
      adapter.progress({
        runId: "run-1",
        mode: "workflow",
        children: [{
          index: 0,
          runId: "child-run",
          agent: "scout",
          status: "running",
          task: "Inspect",
          tokens: 1,
          toolCount: 1,
          durationMs: 1,
          sessionFile: null
        }]
      })
      await refreshing
      // The workflow container root is projected alongside its step child.
      const child = adapter.snapshot().nodes.find(
        (node) => node.nodeKind === "agent"
      )
      const durableId = child?.id
      expect(durableId).toBe(`${parent}/child-run`)
      expect(child?.health).toBe("unknown")
      expect(adapter.snapshot().nodes.some(
        (node) => node.nodeKind === "workflow" && node.id === `${parent}/run-1`
      )).toBe(true)
      events.emit("subagent:async-complete", {
        runId: "run-1",
        sessionId: parentSessionFile,
        state: "complete",
        success: true,
        results: [{
          runId: "child-run",
          index: 0,
          agent: "scout",
          success: true,
          sessionPath: "/sessions/child.jsonl"
        }]
      })
      expect(adapter.snapshot().nodes).toEqual([])
      expect(emitted.some((event) =>
        event._tag === "Upsert" &&
        event.node.id === durableId &&
        event.node.status === "completed" &&
        event.node.sessionFile === "/sessions/child.jsonl"
      )).toBe(true)
    } finally {
      adapter.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

})

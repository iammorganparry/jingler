import { createEventBus } from "@earendil-works/pi-coding-agent"
import type { SubagentFleetEvent } from "@jingler/core"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { PiSubagentLifecycleAdapter } from "./pi-subagent-lifecycle-adapter.js"

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

  it("publishes live child progress and bounded supervisor state without polling", () => {
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

    expect(adapter.snapshot().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subagentId: "run-1:step:0",
        currentTool: "workspace_read_file",
        sessionFile: "/sessions/child.jsonl",
        usage: expect.objectContaining({ totalTokens: 5, toolCalls: 1 })
      })
    ]))
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

  it("does not leave an observed process reported as running", () => {
    const events = createEventBus()
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentPiSessionId: parent,
      controlJournal: null,
      emit: () => undefined,
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

    expect(adapter.snapshot().nodes[0]).toMatchObject({
      status: "unknown",
      completedAt: 20
    })
    adapter.stop()
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
      await adapter.refresh()
      const durableId = adapter.snapshot().nodes[0]?.id
      expect(durableId).toBe(`${parent}/child-run`)
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

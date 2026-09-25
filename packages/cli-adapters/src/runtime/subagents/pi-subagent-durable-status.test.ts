import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { readDurablePiSubagentNodes } from "./pi-subagent-durable-status.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

describe("readDurablePiSubagentNodes", () => {
  it("projects only active runs owned by the resumed parent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-durable-fleet-"))
    roots.push(root)
    await Promise.all([
      mkdir(join(root, ".active-runs"), { recursive: true }),
      mkdir(join(root, "run-1"), { recursive: true }),
      mkdir(join(root, "starting"), { recursive: true }),
      mkdir(join(root, "foreign"), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(root, ".active-runs", "run-1"), ""),
      writeFile(join(root, ".active-runs", "starting"), ""),
      writeFile(join(root, ".active-runs", "foreign"), ""),
      writeFile(join(root, "run-1", "status.json"), JSON.stringify({
        runId: "run-1",
        sessionId: "/sessions/parent.jsonl",
        state: "running",
        mode: "workflow",
        startedAt: 10,
        lastUpdate: 20,
        steps: [{
          agent: "scout",
          workflowKey: "main",
          status: "running",
          startedAt: 12,
          model: "test/model"
        }]
      })),
      writeFile(join(root, "starting", "status.json"), JSON.stringify({
        runId: "starting",
        sessionId: "/sessions/parent.jsonl",
        state: "queued",
        mode: "workflow",
        startedAt: 15,
        lastUpdate: 20
      })),
      writeFile(join(root, "foreign", "status.json"), JSON.stringify({
        runId: "foreign",
        sessionId: "/sessions/other.jsonl",
        state: "running",
        startedAt: 10
      }))
    ])

    const projection = await Effect.runPromise(readDurablePiSubagentNodes({
      asyncDir: root,
      parentRuntimeSessionId: "parent",
      parentPiSessionAliases: new Set(["parent", "/sessions/parent.jsonl"]),
      now: 30
    }))

    // A workflow projects its container root AND its steps: the root has no
    // pi session of its own, so the steps must stay selectable beside it.
    expect(projection.nodes).toHaveLength(3)
    expect(projection.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "parent/run-1",
        subagentId: "run-1",
        nodeKind: "workflow",
        parentId: null,
        sessionFile: null
      }),
      expect.objectContaining({
        id: "parent/run-1%3Astep%3A0",
        subagentId: "run-1:step:0",
        orchestrationRunId: "run-1",
        parentId: "parent/run-1",
        agent: "scout",
        model: "test/model"
      }),
      expect.objectContaining({
        id: "parent/starting",
        subagentId: "starting",
        parentId: null,
        // The bare "workflow" mode token is relabelled honestly.
        agent: "Subagent",
        status: "queued"
      })
    ]))
  })

  it("keeps a workflow's completed steps selectable for their transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-durable-steps-"))
    roots.push(root)
    await mkdir(join(root, ".active-runs"), { recursive: true })
    await mkdir(join(root, "wf-1"), { recursive: true })
    await writeFile(join(root, ".active-runs", "wf-1"), "")
    await writeFile(join(root, "wf-1", "status.json"), JSON.stringify({
      runId: "wf-1",
      sessionId: "parent",
      state: "running",
      mode: "workflow",
      startedAt: 10,
      lastUpdate: 40,
      steps: [
        {
          agent: "scout",
          status: "completed",
          startedAt: 12,
          sessionFile: "/sessions/child-a.jsonl"
        },
        { agent: "builder", status: "running", startedAt: 20 },
        // No transcript and no longer active: nothing to select, so dropped.
        { agent: "planner", status: "completed" }
      ]
    }))

    const projection = await Effect.runPromise(readDurablePiSubagentNodes({
      asyncDir: root,
      parentRuntimeSessionId: "parent",
      parentPiSessionAliases: new Set(["parent"]),
      now: 50
    }))

    // A completed step's sessionFile is the workflow's only output — dropping
    // it left "the transcript is not available yet" as the permanent answer.
    expect(projection.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subagentId: "wf-1", nodeKind: "workflow" }),
      expect.objectContaining({
        agent: "scout",
        status: "completed",
        sessionFile: "/sessions/child-a.jsonl",
        parentId: "parent/wf-1"
      }),
      expect.objectContaining({ agent: "builder", status: "running" })
    ]))
    expect(projection.nodes).toHaveLength(3)
    // Root + builder are running; the finished step is not active work.
    expect(projection.totalActive).toBe(2)
  })

  it("rejects malformed and marker-mismatched status records", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-durable-invalid-"))
    roots.push(root)
    await mkdir(join(root, ".active-runs"), { recursive: true })
    for (const runId of ["malformed", "mismatch", "missing-session"]) {
      await mkdir(join(root, runId), { recursive: true })
      await writeFile(join(root, ".active-runs", runId), "")
    }
    await writeFile(join(root, "malformed", "status.json"), "{not-json")
    await writeFile(join(root, "mismatch", "status.json"), JSON.stringify({
      runId: "other",
      sessionId: "parent",
      state: "running",
      mode: "single",
      startedAt: 1
    }))
    await writeFile(join(root, "missing-session", "status.json"), JSON.stringify({
      runId: "missing-session",
      state: "running",
      mode: "single",
      startedAt: 1
    }))

    const projection = await Effect.runPromise(readDurablePiSubagentNodes({
      asyncDir: root,
      parentRuntimeSessionId: "parent",
      parentPiSessionAliases: new Set(["parent"]),
      registryRevision: 2
    }))
    expect(projection).toMatchObject({ nodes: [], totalActive: 0, omitted: 0 })
  })

  it("scans multiple read batches before bounding and reports exact omissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-durable-batches-"))
    roots.push(root)
    await mkdir(join(root, ".active-runs"), { recursive: true })
    const runIds = Array.from({ length: 40 }, (_, index) =>
      `run-${index.toString().padStart(2, "0")}`
    )
    await Promise.all(runIds.map(async (runId, index) => {
      await mkdir(join(root, runId), { recursive: true })
      await writeFile(join(root, ".active-runs", runId), "")
      await writeFile(join(root, runId, "status.json"), JSON.stringify({
        runId,
        sessionId: "parent",
        state: "running",
        mode: "single",
        startedAt: runIds.length - index
      }))
    }))

    const projection = await Effect.runPromise(readDurablePiSubagentNodes({
      asyncDir: root,
      parentRuntimeSessionId: "parent",
      parentPiSessionAliases: new Set(["parent"]),
      maxNodes: 2
    }))

    expect(projection.nodes.map(({ subagentId }) => subagentId))
      .toEqual(["run-39", "run-38"])
    expect(projection).toMatchObject({
      totalActive: 40,
      omitted: 38,
      activeCapacity: { used: 40, limit: 4 }
    })
  })

  it("sorts before bounding and reports exact omissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-durable-bound-"))
    roots.push(root)
    await mkdir(join(root, ".active-runs"), { recursive: true })
    await Promise.all(["late", "early", "middle"].map(async (runId, index) => {
      await mkdir(join(root, runId), { recursive: true })
      await writeFile(join(root, ".active-runs", runId), "")
      await writeFile(join(root, runId, "status.json"), JSON.stringify({
        runId,
        sessionId: "parent",
        state: "running",
        mode: "single",
        startedAt: [30, 10, 20][index]
      }))
    }))

    const projection = await Effect.runPromise(readDurablePiSubagentNodes({
      asyncDir: root,
      parentRuntimeSessionId: "parent",
      parentPiSessionAliases: new Set(["parent"]),
      registryRevision: 7,
      maxNodes: 2
    }))
    expect(projection.nodes.map(({ subagentId }) => subagentId)).toEqual(["early", "middle"])
    expect(projection).toMatchObject({
      totalActive: 3,
      omitted: 1,
      activeCapacity: { used: 3, limit: 4 }
    })
    expect(projection.nodes.every(({ registryRevision }) => registryRevision === 7)).toBe(true)
  })

})

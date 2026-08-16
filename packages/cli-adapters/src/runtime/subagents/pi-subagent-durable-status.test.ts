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
      parentPiSessionId: "parent",
      parentPiSessionAliases: new Set(["parent", "/sessions/parent.jsonl"]),
      now: 30
    }))

    expect(projection.nodes).toHaveLength(2)
    expect(projection.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "parent/run-1%3Astep%3A0",
        subagentId: "run-1:step:0",
        orchestrationRunId: "run-1",
        parentId: null,
        agent: "scout",
        model: "test/model"
      }),
      expect.objectContaining({
        id: "parent/starting",
        subagentId: "starting",
        parentId: null,
        agent: "workflow",
        status: "queued"
      })
    ]))
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
      parentPiSessionId: "parent",
      parentPiSessionAliases: new Set(["parent"]),
      registryRevision: 2
    }))
    expect(projection).toMatchObject({ nodes: [], totalActive: 0, omitted: 0 })
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
      parentPiSessionId: "parent",
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

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
      mkdir(join(root, "foreign"), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(root, ".active-runs", "run-1"), ""),
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
      writeFile(join(root, "foreign", "status.json"), JSON.stringify({
        runId: "foreign",
        sessionId: "/sessions/other.jsonl",
        state: "running",
        startedAt: 10
      }))
    ])

    const nodes = await readDurablePiSubagentNodes({
      asyncDir: root,
      parentPiSessionId: "parent",
      parentPiSessionAliases: new Set(["parent", "/sessions/parent.jsonl"]),
      now: 30
    })

    expect(nodes).toHaveLength(2)
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "parent/active/run-1",
        runId: "run-1",
        agent: "scout",
        status: "running"
      }),
      expect.objectContaining({
        id: "parent/active/run-1/main",
        parentId: "parent/active/run-1",
        agent: "scout",
        model: "test/model"
      })
    ]))
  })
})

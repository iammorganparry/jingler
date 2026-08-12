import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { RunJournal } from "../journal/run-journal.js"
import { createMutationObserver } from "./mutation-observer.js"
import { ToolRegistry } from "./tool-registry.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
)

const repository = async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "jingler-observer-"))
  roots.push(stateRoot)
  const root = join(stateRoot, "workspace")
  await mkdir(root)
  execFileSync("git", ["init", "-q"], { cwd: root })
  return { root, stateRoot }
}

describe("mutation observer", () => {
  it("attaches actual file changes and settles the durable receipt", async () => {
    const { root: cwd, stateRoot } = await repository()
    const tracker = new FileChangeTracker({
      artifactDir: join(cwd, ".artifacts"),
      sessionId: "session-1"
    })
    const journal = new RunJournal({
      file: join(stateRoot, "journal", "run.json")
    })
    const registry = new ToolRegistry({
      observer: createMutationObserver({
        cwd,
        runId: "run-1",
        sessionId: "session-1",
        chatId: "chat-1",
        tracker,
        journal
      })
    })
    registry.register({
      id: "workspace_write",
      version: "1",
      description: "Write a file.",
      input: Schema.Struct({ path: Schema.String, content: Schema.String }),
      risk: "mutate",
      roles: ["conversation"],
      modes: ["ask"],
      timeoutMs: 1_000,
      outputBudget: 1_000,
      cancellable: true,
      idempotency: "keyed",
      execute: ({ path, content }) => writeFile(join(cwd, path), content)
    })

    const result = await Effect.runPromise(
      registry.execute({
        id: "workspace_write",
        arguments: { path: "created.ts", content: "export const value = 1\n" },
        role: "conversation",
        mode: "ask",
        callId: "call-1",
        idempotencyKey: "call-1"
      })
    )
    expect(result.fileChanges?.changes).toEqual([
      expect.objectContaining({ status: "A", path: "created.ts" })
    ])
    expect(await Effect.runPromise(journal.list())).toEqual([
      expect.objectContaining({
        callId: "call-1",
        status: "settled",
        fileChangeSetIds: [result.fileChanges?.id]
      })
    ])
  })
})

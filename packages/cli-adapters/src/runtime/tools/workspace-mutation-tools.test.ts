import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AssetService } from "../../asset.js"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { RunJournal } from "../journal/run-journal.js"
import { createMutationObserver } from "./mutation-observer.js"
import { ToolRegistry } from "./tool-registry.js"
import {
  makeWorkspaceMutationPort,
  registerWorkspaceMutationTools,
  type WorkspaceMutationPort
} from "./workspace-mutation-tools.js"

const TestLayer = AssetService.Default.pipe(Layer.provideMerge(NodeContext.layer))

let workspace: string
let outside: string
let port: WorkspaceMutationPort
let callSequence = 0

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jingler-workspace-tools-"))
  outside = await mkdtemp(join(tmpdir(), "jingler-workspace-outside-"))
  execFileSync("git", ["init", "-q"], { cwd: workspace })
  port = await Effect.runPromise(makeWorkspaceMutationPort.pipe(Effect.provide(TestLayer)))
  callSequence = 0
})

afterEach(async () => {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ])
})

const execute = (
  registry: ToolRegistry,
  id: string,
  args: unknown,
  idempotencyKey: string | null = `${id}-${++callSequence}`
) => Effect.runPromise(registry.execute({
  id,
  arguments: args,
  role: "conversation",
  mode: "ask",
  idempotencyKey
}))

const makeRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry({
    observer: createMutationObserver({
      cwd: workspace,
      runId: "run-1",
      sessionId: "session-1",
      chatId: "chat-1",
      tracker: new FileChangeTracker({
        artifactDir: join(outside, "artifacts"),
        sessionId: "session-1"
      }),
      journal: new RunJournal({ file: join(outside, "journal.json") })
    })
  })
  registerWorkspaceMutationTools(registry, workspace, port)
  return registry
}

describe("workspace mutation tools", () => {
  it("creates, edits, renames, and deletes files through registered tools", async () => {
    const registry = makeRegistry()

    await expect(execute(registry, "workspace_write", {
      path: "src/example.ts",
      content: "export const value = 1\n"
    })).resolves.toMatchObject({ status: "success" })
    await expect(execute(registry, "workspace_edit", {
      path: "src/example.ts",
      oldText: "value = 1",
      newText: "value = 2"
    })).resolves.toMatchObject({
      status: "success",
      value: { path: "src/example.ts", replacements: 1 }
    })
    await expect(execute(registry, "workspace_rename", {
      from: "src/example.ts",
      to: "src/renamed.ts"
    })).resolves.toMatchObject({ status: "success" })
    expect(await readFile(join(workspace, "src/renamed.ts"), "utf8"))
      .toBe("export const value = 2\n")
    await expect(execute(registry, "workspace_delete", {
      path: "src/renamed.ts"
    })).resolves.toMatchObject({ status: "success" })
    await expect(readFile(join(workspace, "src/renamed.ts"), "utf8")).rejects.toThrow()
  })

  it("rejects traversal, escaping symlinks, and missing idempotency keys", async () => {
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(outside, join(workspace, "escape"))
    const registry = makeRegistry()

    await expect(execute(registry, "workspace_write", {
      path: "../outside.txt",
      content: "nope"
    })).resolves.toMatchObject({
      status: "error",
      error: { code: "execution-failed" }
    })
    await expect(execute(registry, "workspace_write", {
      path: "escape/new.txt",
      content: "nope"
    })).resolves.toMatchObject({
      status: "error",
      error: { code: "execution-failed" }
    })
    await expect(execute(registry, "workspace_write", {
      path: "missing-key.txt",
      content: "nope"
    }, null)).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid-input" }
    })
  })

  it("runs commands with streamed output and omits mutation tools from read-only roles", async () => {
    const registry = makeRegistry()
    const progress: string[] = []

    const result = await Effect.runPromise(registry.execute({
      id: "command_execute",
      arguments: { command: "printf 'hello'" },
      role: "conversation",
      mode: "ask",
      callId: "command-call",
      progress: (update) => progress.push(update.message)
    }))

    expect(result).toMatchObject({
      status: "success",
      value: { exitCode: 0, stdout: "hello", stderr: "" }
    })
    expect(progress.join("")).toBe("hello")
    expect(registry.capabilitiesFor("plan", "read-only")).toEqual([])
    expect(registry.capabilitiesFor("review", "read-only")).toEqual([])
  })
})

import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AssetService } from "../../asset.js"
import { ToolRegistry } from "./tool-registry.js"
import {
  makeWorkspaceInspectionPort,
  registerWorkspaceInspectionTools,
  type WorkspaceInspectionPort,
  validateInspectionCommand
} from "./workspace-tools.js"

const workspace: WorkspaceInspectionPort = {
  listFiles: () =>
    Effect.succeed([
      { path: "src/index.ts", status: "modified" },
      { path: "src/new.ts", status: "untracked" }
    ]),
  readTextFile: (_cwd, path) =>
    Effect.succeed({
      path,
      text: "export const answer = 42\n",
      language: "typescript",
      revision: "sha256:test"
    }),
  executeReadOnly: (_cwd, program, args) => Effect.succeed({
    command: [program, ...args].join(" "),
    exitCode: 0,
    stdout: "result\n",
    stderr: ""
  })
}

describe("workspace inspection tools", () => {
  it("executes allowed Git and ripgrep commands without a shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jingler-read-command-"))
    try {
      execFileSync("git", ["init", "-q"], { cwd })
      await writeFile(join(cwd, "README.md"), "inspection needle\n")
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd })
      execFileSync("git", ["config", "user.name", "Test"], { cwd })
      execFileSync("git", ["add", "."], { cwd })
      execFileSync("git", ["commit", "-qm", "base"], { cwd })
      await writeFile(join(cwd, "editor.sh"), "#!/bin/sh\ntouch editor-sentinel\n", { mode: 0o700 })
      execFileSync("git", ["config", "core.editor", "./editor.sh"], { cwd })
      const port = await Effect.runPromise(
        makeWorkspaceInspectionPort.pipe(
          Effect.provide(AssetService.Default.pipe(Layer.provideMerge(NodeContext.layer)))
        )
      )
      const context = {
        signal: new AbortController().signal,
        idempotencyKey: null,
        progress: () => {}
      }
      await expect(Effect.runPromise(port.executeReadOnly(cwd, "git", ["status", "--short"], context)))
        .resolves.toMatchObject({ stdout: "?? editor.sh\n" })
      for (const args of [["branch", "--edit-description"], ["branch", "--no-edit-description"], ["branch", "-lD"], ["branch", "--edit-descript"], ["branch", "--no-edit-descript"], ["branch", "-avf"], ["branch", "--unknown"], ...["diff", "grep", "log", "ls-tree", "rev-parse", "show", "status"].flatMap(command => [[command, "--output=../sentinel"], [command, "--no-ext-dif"], [command, "--no-no-ext-diff"], [command, "--ext-diff"], [command, "-nc"], [command, "--unknown"]])]) {
        await expect(Effect.runPromise(port.executeReadOnly(cwd, "git", args, context))).rejects.toThrow()
      }
      expect(existsSync(join(cwd, "editor-sentinel"))).toBe(false)
      for (const args of [["branch", "--list"], ["diff", "--stat"], ["grep", "-n", "needle"], ["log", "--oneline", "-5"], ["ls-tree", "--name-only", "HEAD"], ["rev-parse", "--verify", "HEAD"], ["show", "HEAD:README.md"]]) {
        await expect(Effect.runPromise(port.executeReadOnly(cwd, "git", args, context))).resolves.toMatchObject({ exitCode: 0 })
      }
      await expect(Effect.runPromise(port.executeReadOnly(cwd, "rg", ["needle"], context)))
        .resolves.toMatchObject({ stdout: expect.stringContaining("README.md") })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("uses one cwd-bound port for list and read", async () => {
    const registry = new ToolRegistry()
    registerWorkspaceInspectionTools(registry, "/repo", workspace)

    const files = await Effect.runPromise(
      registry.execute({
        id: "workspace_list_files",
        arguments: {},
        role: "review",
        mode: "read-only"
      })
    )
    const file = await Effect.runPromise(
      registry.execute({
        id: "workspace_read_file",
        arguments: { path: "src/index.ts" },
        role: "plan",
        mode: "plan"
      })
    )

    expect(files.value).toEqual([
      { path: "src/index.ts", status: "modified" },
      { path: "src/new.ts", status: "untracked" }
    ])
    expect(file.value).toMatchObject({
      path: "src/index.ts",
      text: "export const answer = 42\n"
    })

    const command = await Effect.runPromise(registry.execute({
      id: "command_inspect",
      arguments: { program: "git", args: ["log", "--oneline", "-5"] },
      role: "plan",
      mode: "plan"
    }))
    expect(command.value).toMatchObject({ command: "git log --oneline -5" })
    expect(registry.capabilitiesFor("review", "read-only").map(({ id }) => id))
      .toContain("command_inspect")
  })

  it("allows repository archaeology and rejects execution or traversal", () => {
    expect(() => validateInspectionCommand("git", ["log", "--oneline", "-5"])).not.toThrow()
    expect(() => validateInspectionCommand("git", ["show", "HEAD:README.md"])).not.toThrow()
    expect(() => validateInspectionCommand("git", ["commit", "-m", "nope"])).toThrow("not read-only")
    expect(() => validateInspectionCommand("git", ["diff", "--no-index", "a", "b"])).toThrow("escape")
    expect(() => validateInspectionCommand("git", ["show", "--output=stolen.txt", "HEAD"])).toThrow("escape")
    expect(() => validateInspectionCommand("git", ["branch", "-D", "topic", "--list"])).toThrow("listing")
    expect(() => validateInspectionCommand("git", ["show", "../outside"])).toThrow("outside")
    expect(() => validateInspectionCommand("git", ["show", "HEAD:../outside"])).toThrow("outside")
    expect(() => validateInspectionCommand("git", ["-c", "alias.x=!touch marker", "x"])).toThrow("not read-only")
    expect(() => validateInspectionCommand("rg", ["needle"])).not.toThrow()
    expect(() => validateInspectionCommand("rg", ["--pre", "cat", "needle"])).toThrow("flag is unavailable")
    expect(() => validateInspectionCommand("rg", ["needle", "../outside"])).toThrow("outside")
  })

  it("schema-rejects missing paths before the port executes", async () => {
    let reads = 0
    const registry = new ToolRegistry()
    registerWorkspaceInspectionTools(registry, "/repo", {
      ...workspace,
      readTextFile: () => {
        reads += 1
        return workspace.readTextFile("/repo", "unused")
      }
    })

    const result = await Effect.runPromise(
      registry.execute({
        id: "workspace_read_file",
        arguments: {},
        role: "conversation",
        mode: "ask"
      })
    )
    expect(result.error?.code).toBe("invalid-input")
    expect(reads).toBe(0)
  })
})

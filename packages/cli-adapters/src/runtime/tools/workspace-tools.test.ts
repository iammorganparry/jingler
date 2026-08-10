import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ToolRegistry } from "./tool-registry.js"
import {
  registerWorkspaceInspectionTools,
  type WorkspaceInspectionPort
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
    })
}

describe("workspace inspection tools", () => {
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

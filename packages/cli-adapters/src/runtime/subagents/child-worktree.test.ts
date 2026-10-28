import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import { registerNativeSubagentTool } from "../agent/native-subagent-tool.js"
import { createChildWorktree } from "./child-worktree.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const spec = { runId: "r", cwd: "/parent" } as never

const run = (registry: ToolRegistry, args: unknown) =>
  Effect.runPromise(registry.execute({ id: "subagent", arguments: args, role: "conversation", mode: "auto" }))
const delegate = () => vi.fn(async (_r: { cwd: string }) => ({ status: "completed", runId: "c", agent: "researcher", result: { kind: "text", text: "ok" } }) as never)

describe("subagent isolation", () => {
  it("keeps the parent cwd when isolation is omitted", async () => {
    const d = delegate()
    const create = vi.fn(async () => "/never")
    const registry = new ToolRegistry()
    registerNativeSubagentTool(registry, spec, d, undefined, undefined, undefined, create)
    await run(registry, { agent: "researcher", task: "t" })
    expect(d.mock.calls[0]![0].cwd).toBe("/parent")
    expect(create).not.toHaveBeenCalled()
  })

  it("creates a managed worktree off parent HEAD and passes it as the child cwd", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sub-iso-")))
    const repo = join(root, "repo")
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    writeFileSync(join(repo, "a.txt"), "a")
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    const worktreesDir = join(root, "worktrees")
    const create = await Effect.runPromise(Effect.gen(function* () {
      return createChildWorktree(
        { worktreesDir } as never,
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        yield* CommandExecutor.CommandExecutor
      )
    }).pipe(Effect.provide(NodeContext.layer)))
    const d = delegate()
    const registry = new ToolRegistry()
    registerNativeSubagentTool(registry, { runId: "r", cwd: repo } as never, d, undefined, undefined, undefined, create)
    await run(registry, { agent: "researcher", task: "t", isolation: "worktree" })
    const cwd = d.mock.calls[0]![0].cwd
    expect(cwd.startsWith(join(worktreesDir, "repo", "sub-"))).toBe(true)
    expect(existsSync(join(cwd, "a.txt"))).toBe(true)
    expect(git(cwd, "branch", "--show-current")).toMatch(/^jingler\/sub\//u)
    expect(git(cwd, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"))
  })
})

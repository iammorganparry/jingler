import { existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CreateSessionInput } from "@jingler/core"
import { ProviderConnectionId, ProviderId, ProviderModelId } from "@jingler/core"
import { Effect, Layer, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GitService } from "./git.js"
import { ProjectService } from "./projects.js"
import { SessionStore } from "./sessions.js"
import { initGitRepo, mkTemp, withTempRoot } from "./test-support.js"
import { closeWorkspaceAdmission, resetWorkspaceAdmissions, workspaceActivityCount } from "./workspace-admission.js"
import { copyApprovedFile, WorkspaceWorkflowService } from "./workspace-workflow.js"

const resources: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  resetWorkspaceAdmissions()
  for (const cleanup of resources.splice(0)) cleanup()
})

const fixture = () => {
  const files = mkTemp("workflow-safety-")
  resources.push(files.cleanup)
  const root = initGitRepo(join(files.dir, "project"))
  const target = join(files.dir, "target")
  mkdirSync(target)
  writeFileSync(join(root, ".gitignore"), "*.secret\nconfig/\n")
  return { files, root, target }
}

const harness = async (setup: string, body: (workflow: WorkspaceWorkflowService, sessionId: string, worktree: string, state: { read(): Promise<import("@jingler/core").Session>; safe(): Promise<unknown>; reconcile(): Promise<unknown> }) => Promise<void>, run = "sleep 5", cleanup?: string) => {
  const temp = withTempRoot()
  resources.push(temp.cleanup)
  const { root } = fixture()
  const services = Layer.mergeAll(SessionStore.Default, ProjectService.Default, GitService.Default)
  await Effect.runPromise(Effect.gen(function* () {
    const project = yield* ProjectService.register({ path: root })
    yield* ProjectService.setWorkflow(project.id, { setup, ...(cleanup ? { cleanup } : {}), runs: [{ id: "run", label: "Run", command: run }], copyFiles: [] }, true)
    const input: CreateSessionInput = {
      repoPath: root, repoName: "project", title: "Safety test", projectId: project.id, baseBranch: "main",
      connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("claude-max"),
      providerId: Schema.decodeUnknownSync(ProviderId)("anthropic"),
      modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet")
    }
    const session = yield* SessionStore.create(input)
    const workflow = yield* WorkspaceWorkflowService
    yield* Effect.promise(() => body(workflow, session.id, session.worktreePath!, {
      read: () => Effect.runPromise(SessionStore.get(session.id).pipe(Effect.provide(services), Effect.provide(temp.layer))),
      safe: () => Effect.runPromise(SessionStore.setCheckpointSafeMode(session.id, true).pipe(Effect.provide(services), Effect.provide(temp.layer))),
      reconcile: () => Effect.runPromise(SessionStore.reconcileInterruptedWorkspaceLifecycles().pipe(Effect.provide(services), Effect.provide(temp.layer)))
    }))
  }).pipe(
    Effect.provide(WorkspaceWorkflowService.Default.pipe(Layer.provideMerge(services))),
    Effect.provide(temp.layer)
  ))
}

it("refuses unsupported Windows commands before marking execution history", async () => {
  await harness("touch setup-proof", async (workflow, id, cwd, state) => {
    const platform = process.platform
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow("Windows")
      expect((await state.read()).checkpointExecutionHistory).toBe("clean")
      expect(existsSync(join(cwd, "setup-proof"))).toBe(false)
      await Effect.runPromise(workflow.skipSetup(id))
      await expect(Effect.runPromise(workflow.startRun(id, "run"))).rejects.toThrow("Windows")
      expect((await state.read()).checkpointExecutionHistory).toBe("clean")
      const owner = closeWorkspaceAdmission(id, "cleanup test")
      await expect(Effect.runPromise(workflow.cleanup(id, owner))).rejects.toThrow("Windows")
      expect((await state.read()).checkpointExecutionHistory).toBe("clean")
      expect(existsSync(join(cwd, "cleanup-proof"))).toBe(false)
    } finally { Object.defineProperty(process, "platform", { value: platform }) }
  }, "touch run-proof", "touch cleanup-proof")
})

describe("approved file safety", () => {
  it("copies through an owner-only replacement without truncating an existing inode", async () => {
    const { root, target } = fixture()
    writeFileSync(join(root, "a.secret"), "secret")
    writeFileSync(join(target, "a.secret"), "old")
    const old = statSync(join(target, "a.secret")).ino
    await copyApprovedFile(root, target, "a.secret")
    expect(readFileSync(join(target, "a.secret"), "utf8")).toBe("secret")
    expect(statSync(join(target, "a.secret")).ino).not.toBe(old)
    expect(statSync(join(target, "a.secret")).mode & 0o777).toBe(0o600)
  })

  it("refuses a destination symlink and hardlink without changing their referent", async () => {
    const { root, target, files } = fixture()
    writeFileSync(join(root, "a.secret"), "secret")
    const victim = join(files.dir, "victim")
    writeFileSync(victim, "safe")
    symlinkSync(victim, join(target, "a.secret"))
    await expect(copyApprovedFile(root, target, "a.secret")).rejects.toThrow(/destination/)
    linkSync(victim, join(target, "b.secret"))
    writeFileSync(join(root, "b.secret"), "secret")
    await expect(copyApprovedFile(root, target, "b.secret")).rejects.toThrow(/destination/)
    expect(readFileSync(victim, "utf8")).toBe("safe")
  })

  it("rejects an escaping ancestor before creating any nested directories", async () => {
    const { root, target, files } = fixture()
    mkdirSync(join(root, "config", "nested"), { recursive: true })
    writeFileSync(join(root, "config", "nested", "a.secret"), "secret")
    const outside = join(files.dir, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(target, "config"))
    await expect(copyApprovedFile(root, target, "config/nested/a.secret")).rejects.toThrow(/ancestor/)
    expect(existsSync(join(outside, "nested"))).toBe(false)
  })

  it("refuses oversized input and source symlinks", async () => {
    const { root, target } = fixture()
    writeFileSync(join(root, "a.secret"), Buffer.alloc(16 * 1024 * 1024 + 1))
    await expect(copyApprovedFile(root, target, "a.secret")).rejects.toThrow(/16 MiB/)
    symlinkSync(join(root, "a.secret"), join(root, "b.secret"))
    await expect(copyApprovedFile(root, target, "b.secret")).rejects.toThrow()
    expect(existsSync(join(target, "a.secret"))).toBe(false)
  })
})

it("runs real setup under its own closed admission without self-blocking", async () => {
  await harness("printf ready > setup-marker", async (workflow, id, worktree) => {
    const session = await Effect.runPromise(workflow.setup(id))
    expect(session.workspaceLifecycle?.status).toBe("ready")
    expect(readFileSync(join(worktree, "setup-marker"), "utf8")).toBe("ready")
    expect(workspaceActivityCount(id)).toBe(0)
  })
})

it("rejects setup/skip/archive overlap while the real setup process is running", async () => {
  await harness("touch starting; sleep 0.3", async (workflow, id, worktree) => {
    const pending = Effect.runPromise(workflow.setup(id))
    await expect.poll(() => existsSync(join(worktree, "starting"))).toBe(true)
    await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow(/already in progress/)
    await expect(Effect.runPromise(workflow.skipSetup(id))).rejects.toThrow(/already in progress/)
    expect(() => closeWorkspaceAdmission(id, "archive")).toThrow(/already unavailable/)
    expect((await pending).workspaceLifecycle?.status).toBe("ready")
  })
})

it("allows an explicit failed-setup retry and serializes simultaneous Run starts", async () => {
  await harness("if [ ! -f attempted ]; then touch attempted; exit 1; fi", async (workflow, id) => {
    await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow(/Setup exited/)
    expect((await Effect.runPromise(workflow.setup(id))).workspaceLifecycle?.status).toBe("ready")
    const starts = await Promise.allSettled([Effect.runPromise(workflow.startRun(id, "run")), Effect.runPromise(workflow.startRun(id, "run"))])
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    await Effect.runPromise(workflow.stopAll(id))
    expect(workspaceActivityCount(id)).toBe(0)
  })
})

it("retains Run admission until descendants of an early-exiting leader disappear", async () => {
  await harness("true", async (workflow, id, worktree) => {
    await Effect.runPromise(workflow.setup(id))
    await Effect.runPromise(workflow.startRun(id, "run"))
    await expect.poll(async () => (await Effect.runPromise(workflow.listRuns(id)))[0]?.status).toBe("exited")
    const pid = Number(readFileSync(join(worktree, "descendant"), "utf8").trim())
    expect(() => process.kill(pid, 0)).toThrow()
    expect(workspaceActivityCount(id)).toBe(0)
  }, "sleep 60 >/dev/null 2>&1 & echo $! > descendant; exit 0")
})

it("requires the actual closure owner for cleanup and preserves failed admission for retry", async () => {
  await harness("true", async (workflow, id) => {
    await Effect.runPromise(workflow.setup(id))
    const owner = closeWorkspaceAdmission(id, "archive")
    await expect(Effect.runPromise(workflow.cleanup(id, Symbol("archive")))).rejects.toThrow(/owner/)
    await Effect.runPromise(workflow.cleanup(id, owner))
  })
})

it("transfers only an idle failed setup to an exclusive archive owner", async () => {
  await harness("exit 1", async (workflow, id) => {
    await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow(/Setup exited/)
    await Effect.runPromise(workflow.prepareLifecycle(id))
    const owner = closeWorkspaceAdmission(id, "archive")
    await Effect.runPromise(workflow.cleanup(id, owner))
    await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow(/already unavailable/)
  })
})

it("copies ignored nested files when fresh destination parents do not exist", async () => {
  const { root, target } = fixture()
  mkdirSync(join(root, "config", "nested"), { recursive: true })
  writeFileSync(join(root, "config", "nested", "local.secret"), "nested secret")
  await copyApprovedFile(root, target, "config/nested/local.secret")
  expect(readFileSync(join(target, "config", "nested", "local.secret"), "utf8")).toBe("nested secret")
})

it("does not reconcile a live setup as interrupted", async () => {
  await harness("touch preparing; sleep 0.3", async (workflow, id, cwd, state) => {
    const setup = Effect.runPromise(workflow.setup(id))
    await expect.poll(() => existsSync(join(cwd, "preparing"))).toBe(true)
    await state.reconcile()
    expect((await state.read()).workspaceLifecycle?.status).toBe("setup-running")
    await setup
  })
})

it("rejects safe shell setup before tainting execution history", async () => {
  await harness("touch forbidden", async (workflow, id, cwd, state) => {
    await state.safe()
    await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow(/unsupported/)
    expect((await state.read()).checkpointExecutionHistory).toBe("clean")
    expect(existsSync(join(cwd, "forbidden"))).toBe(false)
  })
})

it("named Run has no setup deadline and forgetting removes settled output", async () => {
  await harness("true", async (workflow, id) => {
    await Effect.runPromise(workflow.setup(id))
    const timer = vi.spyOn(globalThis, "setTimeout")
    await Effect.runPromise(workflow.startRun(id, "run"))
    expect(timer.mock.calls.some(call => call[1] === 600000)).toBe(false)
    await Effect.runPromise(workflow.forget(id))
    expect(await Effect.runPromise(workflow.listRuns(id))).toEqual([])
    expect(workspaceActivityCount(id)).toBe(0)
  })
})

it("retains bounded failed command diagnostics without process references", async () => {
  await harness("true", async (workflow, id) => {
    await Effect.runPromise(workflow.setup(id))
    await Effect.runPromise(workflow.startRun(id, "run"))
    await expect.poll(async () => (await Effect.runPromise(workflow.listRuns(id)))[0]?.status).toBe("failed")
    expect((await Effect.runPromise(workflow.listRuns(id)))[0]).toMatchObject({ exitCode: 7, output: "launch failed" })
  }, "printf 'launch failed'; exit 7")
})

it("rejects safe shell cleanup before tainting execution history", async () => {
  await harness("true", async (workflow, id, cwd, state) => {
    await state.safe()
    await expect(Effect.runPromise(workflow.setup(id))).rejects.toThrow(/unsupported/)
    await Effect.runPromise(workflow.skipSetup(id))
    const owner = closeWorkspaceAdmission(id, "cleanup")
    await expect(Effect.runPromise(workflow.cleanup(id, owner))).rejects.toThrow(/unsupported/)
    expect((await state.read()).checkpointExecutionHistory).toBe("clean")
    expect((await state.read()).workspaceLifecycle?.status).toBe("cleanup-failed")
    expect(existsSync(join(cwd, "forbidden"))).toBe(false)
  }, "true", "touch forbidden")
})

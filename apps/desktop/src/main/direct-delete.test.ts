import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { afterEach, beforeEach, expect, it } from "vitest"
import {
  AgentRunner, AgentTurnDriver, BackgroundTaskStore, BrowserControlMcpService,
  ConfigService, ContextManager, ExplanationStore, GitHubAuth, GitService,
  InMemorySecretStoreLive, ProjectService, RemoteSessionService, ReviewStore,
  SessionStore, TerminalService, TranscriptStore, WorkspaceWorkflowService,
  resetWorkspaceAdmissions, workspaceActivityCount
} from "@jingler/cli-adapters"
import { initGitRepo, withTempRoot } from "../../../../packages/cli-adapters/src/test-support.js"
import { PreviewViewService } from "./preview-view.js"
import { deleteSession } from "./rpc.js"

const SESSION = "direct-delete"
let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
  mkdirSync(temp.root, { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([{
    id: SESSION, repo: "checkout", branch: "main", title: "Direct", status: "idle",
    connectionId: "test", providerId: "anthropic", modelId: "anthropic/test",
    diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: now,
    chats: [{ id: SESSION, title: null, createdAt: now, updatedAt: now, connectionId: "test", providerId: "anthropic", modelId: "anthropic/test" }], activeChatId: SESSION
  }]))
})
afterEach(() => { resetWorkspaceAdmissions(); temp.cleanup() })
const BrowserControlMcpServiceTest = Layer.succeed(BrowserControlMcpService, {
  acquire: () => Effect.succeed({ name: "jingler-browser", url: "http://127.0.0.1:32123/mcp", headers: {}, headerEnvironment: {} }), revoke: () => Effect.void
} as never)
const nativeServices = Layer.mergeAll(SessionStore.Default, ProjectService.Default, GitService.Default)
const deletionServices = Layer.mergeAll(
  WorkspaceWorkflowService.Default.pipe(Layer.provideMerge(nativeServices)),
  ExplanationStore.Default, ReviewStore.Default,
  Layer.succeed(GitHubAuth, { sessionRoutes: () => Effect.succeed([]) } as never),
  Layer.succeed(TerminalService, { killSession: () => Effect.void } as never),
  Layer.succeed(PreviewViewService, { deleteSession: () => Effect.void } as never),
  Layer.succeed(RemoteSessionService, {} as never)
)

it("deletes a completed direct turn while its consumer is still attached, preserving the checkout", async () => {
  const checkout = initGitRepo(join(temp.root, "checkout"))
  const sessionsPath = join(temp.root, "sessions.json")
  const records = JSON.parse(readFileSync(sessionsPath, "utf8"))
  records[0] = { ...records[0], workspaceMode: "direct", worktreePath: checkout, repoPath: checkout, branch: "main" }
  writeFileSync(sessionsPath, JSON.stringify(records))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" })
  writeFileSync(join(checkout, "README.md"), "staged content\n")
  git("add", "README.md")
  writeFileSync(join(checkout, "README.md"), "unstaged content\n")
  writeFileSync(join(checkout, "local-data.txt"), "untracked data\n")
  const before = [git("rev-parse", "HEAD"), git("status", "--porcelain"), git("show-ref"), git("worktree", "list", "--porcelain"), readFileSync(join(checkout, ".git", "index")), readFileSync(join(checkout, "README.md")), readFileSync(join(checkout, "local-data.txt"))]
  const adapter = Layer.succeed(AgentTurnDriver, AgentTurnDriver.of({
    run: (_id, _spec, ctx) => ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 }),
    stop: () => Effect.void
  }))
  const base = Layer.mergeAll(
    AgentRunner.Default, BrowserControlMcpServiceTest, InMemorySecretStoreLive,
    ConfigService.Default, SessionStore.Default, TranscriptStore.Default,
    BackgroundTaskStore.Default, adapter, ContextManager.Default, deletionServices
  )
  await Effect.runPromise(Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    const runner = yield* AgentRunner
    yield* runner.setMode(SESSION, "auto")
    const consumer = yield* Effect.fork(runner.prompt(SESSION, SESSION, "complete").pipe(
      Stream.runForEach(event => event._tag === "Done"
        ? Deferred.succeed(done, undefined).pipe(Effect.zipRight(Effect.never))
        : event._tag === "Failed" ? Effect.die(new Error(event.message)) : Effect.void)
    ))
    yield* Effect.raceFirst(Deferred.await(done), Fiber.join(consumer)).pipe(Effect.timeout("1 second"))
    yield* deleteSession(SESSION)
    expect(workspaceActivityCount(SESSION)).toBe(0)
    expect(yield* SessionStore.list()).toEqual([])
    expect(yield* TranscriptStore.list(SESSION)).toEqual([])
    yield* Fiber.interrupt(consumer)
  }).pipe(Effect.provide(base), Effect.provide(temp.layer), Effect.timeout("5 seconds")))
  expect([git("rev-parse", "HEAD"), git("status", "--porcelain"), git("show-ref"), git("worktree", "list", "--porcelain"), readFileSync(join(checkout, ".git", "index")), readFileSync(join(checkout, "README.md")), readFileSync(join(checkout, "local-data.txt"))]).toEqual(before)
})

it.each(["worktree", "direct"] as const)("refuses deletion with unknown PTY descendants in %s mode", async workspaceMode => {
  const checkout = initGitRepo(join(temp.root, "checkout"))
  const sessionsPath = join(temp.root, "sessions.json")
  const records = JSON.parse(readFileSync(sessionsPath, "utf8"))
  records[0] = { ...records[0], workspaceMode, worktreePath: checkout, repoPath: checkout, checkpointPtyHistory: true }
  writeFileSync(sessionsPath, JSON.stringify(records))
  const before = readFileSync(sessionsPath, "utf8")
  const base = Layer.mergeAll(
    deletionServices, AgentRunner.Default, BrowserControlMcpServiceTest,
    InMemorySecretStoreLive, ConfigService.Default, TranscriptStore.Default,
    BackgroundTaskStore.Default, ContextManager.Default,
    Layer.succeed(AgentTurnDriver, AgentTurnDriver.of({ run: () => Effect.void, stop: () => Effect.void }))
  )
  await expect(Effect.runPromise(deleteSession(SESSION).pipe(
    Effect.provide(base), Effect.provide(temp.layer)
  ))).rejects.toThrow(/cannot be proven stopped/)
  expect(readFileSync(sessionsPath, "utf8")).toBe(before)
  expect(readFileSync(join(checkout, "README.md"), "utf8")).toContain(checkout)
  expect(workspaceActivityCount(SESSION)).toBe(0)
})

import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { expect, it, vi } from "vitest"
import { SessionStore, GitService } from "@jingler/cli-adapters"
import { CreateSessionInput, type Session } from "@jingler/core"
import { initGitRepo, mkTemp, withTempRoot } from "../../../../packages/cli-adapters/src/test-support.js"
import { archiveMetadataOnly } from "./metadata-only-archive.js"
vi.mock("@jingler/cli-adapters/workspace-ports", async importOriginal => {
  const actual = await importOriginal<typeof import("@jingler/cli-adapters/workspace-ports")>()
  return { ...actual, allocateWorkspacePorts: (sessions: readonly Session[]) => actual.allocateWorkspacePorts(sessions, undefined, async () => true) }
})
it("acknowledged archive needs no lifecycle/cleanup/PTY services and preserves a real worktree; deletion stays refused", async () => {
  const temp = withTempRoot(); const repo = mkTemp("metadata-archive-")
  try {
    const path = initGitRepo(join(repo.dir, "repo"))
    const input = Schema.decodeUnknownSync(CreateSessionInput)({ repoPath: path, repoName: "repo", title: "Terminal", baseBranch: "main", runtimeId: "pi", connectionId: "test", providerId: "test", modelId: "model" })
    const services = Layer.mergeAll(SessionStore.Default, GitService.Default)
    const run = <A, E>(effect: Effect.Effect<A, E, Effect.Effect.Context<ReturnType<typeof archiveMetadataOnly>>>) => Effect.runPromise(effect.pipe(Effect.provide(services), Effect.provide(temp.layer)))
    const session = await Effect.runPromise(SessionStore.create(input).pipe(Effect.provide(services), Effect.provide(temp.layer)))
    writeFileSync(join(session.worktreePath!, "keep"), "preserved")
    await run(SessionStore.markCheckpointTerminalExecutionUnprovable(session.id))
    await expect(run(archiveMetadataOnly(session.id, "closed", false))).rejects.toThrow("acknowledgement")
    const archived = await run(archiveMetadataOnly(session.id, "closed", true))
    expect(archived.archived).toBe(true); expect(archived.checkpointPtyHistory).toBe(true)
    expect(readFileSync(join(session.worktreePath!, "keep"), "utf8")).toBe("preserved")
    expect(existsSync(join(session.worktreePath!, ".git"))).toBe(true)
    await expect(Effect.runPromise(SessionStore.remove(session.id).pipe(Effect.provide(services), Effect.provide(temp.layer)))).rejects.toThrow("cannot be proven")
  } finally { temp.cleanup(); repo.cleanup() }
})

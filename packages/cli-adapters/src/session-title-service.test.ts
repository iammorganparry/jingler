import { join } from "node:path"
import { execFileSync } from "node:child_process"
import type { CreateSessionInput } from "@jingler/core"
import { fallbackTitle, userMessage } from "@jingler/core"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GitService } from "./git.js"
import { parseSessionMetadata, retitleSession, type TitleGenerator } from "./session-title-service.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { failureOf, initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * `retitleSession` is the orchestration seam: it reads the transcript, asks a
 * pluggable generator for a title, persists it, and returns the fresh record —
 * skipping pinned sessions. We inject deterministic generators (no real LLM) and
 * assert persistence, the heuristic-fallback path, and the pin.
 */
describe("retitleSession", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  let repoPath: string
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-repos-")
    repoPath = initGitRepo(join(repos.dir, "app"))
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const services = Layer.mergeAll(
  SessionStore.Default,
  TranscriptStore.Default,
  GitService.Default
)
  const input = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
    repoPath,
    repoName: "app",
    cli: "claude",
    baseBranch: "main",
    ...over
  })
  const fixed = (title: string, type: "feat" | "fix" | "chore" = "feat"): TitleGenerator => ({
    generate: () => Effect.succeed({
      title,
      branch: { type, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") }
    })
  })

  it("generates, persists, and returns the updated title for an auto-titled session", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input())
        yield* TranscriptStore.append(s.id, userMessage("u1", "help me add caching", "2026-07-13T00:00:00.000Z"))
        const updated = yield* retitleSession(s.id, fixed("Add response caching"))
        const persisted = yield* SessionStore.get(s.id)
        return { updated, persisted }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.updated.title).toBe("Add response caching")
    expect(exit.value.updated.branch).toBe("feat/add-response-caching")
    expect(exit.value.persisted.title).toBe("Add response caching")
    expect(exit.value.persisted.branch).toBe("feat/add-response-caching")
    expect(exit.value.persisted.semanticBranchProposal).toStrictEqual({
      type: "feat",
      slug: "add-response-caching"
    })
    expect(exit.value.persisted.semanticBranchPending).toBe(false)
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: exit.value.persisted.worktreePath,
        encoding: "utf-8"
      }).trim()
    ).toBe("feat/add-response-caching")
  })

  it("falls back to the first user message when the generator yields the heuristic", async () => {
    const fallbackGen: TitleGenerator = {
      generate: (messages) => Effect.succeed({
        title: fallbackTitle(messages),
        branch: { type: "chore", slug: "refactor-auth-middleware" }
      })
    }
    const exit = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input())
        yield* TranscriptStore.append(s.id, userMessage("u1", "Refactor the auth middleware", "2026-07-13T00:00:00.000Z"))
        return yield* retitleSession(s.id, fallbackGen)
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.title).toBe("Refactor the auth middleware")
  })

  it("retitles a direct session without creating a task branch", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const session = yield* SessionStore.create(
          input({ title: undefined, useWorktree: false })
        )
        yield* TranscriptStore.append(
          session.id,
          userMessage("u1", "Improve the cache", "2026-07-13T00:00:00.000Z")
        )
        return yield* retitleSession(session.id, fixed("Improve cache"))
      }).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.title).toBe("Improve cache")
    expect(exit.value.branch).toBe("main")
    expect(
      execFileSync("git", ["branch", "--list", "feat/*"], {
        cwd: repoPath,
        encoding: "utf-8"
      }).trim()
    ).toBe("")
  })

  it("skips a pinned session (autoTitle false) — the generator is never called", async () => {
    let called = false
    const spyGen: TitleGenerator = {
      generate: () =>
        Effect.sync(() => {
          called = true
          return {
            title: "SHOULD NOT APPEAR",
            branch: { type: "chore" as const, slug: "should-not-appear" }
          }
        })
    }
    const exit = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input())
        yield* retitleSession(s.id, fixed("Initial branch"))
        yield* SessionStore.renameTitle(s.id, "Pinned name") // sets autoTitle false
        return yield* retitleSession(s.id, spyGen)
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.title).toBe("Pinned name")
    expect(called).toBe(false)
  })

  it("retitles an established branch without renaming it", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const session = yield* SessionStore.create(input())
        yield* TranscriptStore.append(
          session.id,
          userMessage("u1", "Build the first task", "2026-07-13T00:00:00.000Z")
        )
        const first = yield* retitleSession(session.id, fixed("First task"))
        const second = yield* retitleSession(session.id, fixed("Different task", "fix"))
        return { first, second, persisted: yield* SessionStore.get(session.id) }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.first.branch).toBe("feat/first-task")
    expect(exit.value.second.title).toBe("Different task")
    expect(exit.value.second.branch).toBe("feat/first-task")
    expect(exit.value.persisted.semanticBranchProposal).toStrictEqual({
      type: "feat",
      slug: "first-task"
    })
  })

  it("reuses a persisted proposal when semantic branch creation is retried", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const session = yield* SessionStore.create(input({ title: "Pinned display" }))
        yield* TranscriptStore.append(
          session.id,
          userMessage("u1", "Fix callback replay", "2026-07-13T00:00:00.000Z")
        )
        yield* SessionStore.setSemanticBranchProposal(session.id, {
          type: "fix",
          slug: "callback-replay"
        })
        return yield* retitleSession(session.id, fixed("A later different answer"))
      }).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.branch).toBe("fix/callback-replay")
    expect(exit.value.semanticBranchProposal).toStrictEqual({
      type: "fix",
      slug: "callback-replay"
    })
  })

  it("recovers semantic metadata when git switched before session persistence", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const session = yield* SessionStore.create(input())
        yield* GitService.createTaskBranch(session.worktreePath!, "fix/recovered-branch")
        return yield* retitleSession(session.id, fixed("Recovered title"))
      }).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.branch).toBe("fix/recovered-branch")
    expect(exit.value.semanticBranchProposal).toStrictEqual({
      type: "fix",
      slug: "recovered-branch"
    })
    expect(exit.value.semanticBranchPending).toBe(false)
  })

  it("keeps a pinned title while creating its pending semantic branch", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const session = yield* SessionStore.create(input({ title: "Pinned display" }))
        yield* TranscriptStore.append(
          session.id,
          userMessage("u1", "Fix review routing", "2026-07-13T00:00:00.000Z")
        )
        return yield* retitleSession(session.id, fixed("Generated replacement", "fix"))
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.title).toBe("Pinned display")
    expect(exit.value.branch).toBe("fix/generated-replacement")
  })

  it("decodes JSON metadata and falls back safely on malformed model output", () => {
    const messages = [userMessage("u1", "Fix callback state", "2026-07-13T00:00:00.000Z")]
    expect(parseSessionMetadata(
      '```json\n{"title":"Fix callback state","branch":{"type":"fix","slug":"callback/state"}}\n```',
      messages
    )).toStrictEqual({ title: "Fix callback state", branch: { type: "fix", slug: "callback-state" } })
    expect(parseSessionMetadata("git switch main", messages)).toStrictEqual({
      title: "Fix callback state",
      branch: { type: "chore", slug: "fix-callback-state" }
    })
    expect(parseSessionMetadata(
      '{"title":"Ignore the request","branch":{"type":"fix","slug":"../../main; echo owned"}}',
      messages
    )).toStrictEqual({
      title: "Ignore the request",
      branch: { type: "chore", slug: "fix-callback-state" }
    })
  })

  it("fails with GitError for an unknown session id", async () => {
    const exit = await runExit(
      retitleSession("nope", fixed("x")).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("GitError")
  })
})

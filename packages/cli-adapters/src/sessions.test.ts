import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type {
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  Session
} from "@jingler/core"
import { GhService } from "./gh.js"
import { GitService } from "./git.js"
import { SessionStore, migrateRepoName } from "./sessions.js"
import {
  failureOf,
  fakeCommandExecutor,
  initGitRepo,
  mkTemp,
  runExit,
  withTempRoot
} from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

const activeChat = (session: Session) =>
  session.chats.find((chat) => chat.id === session.activeChatId)!

/**
 * SessionStore persists sessions to disk and forks a real worktree per session.
 * We assert the outcomes a user sees: the session's shape, that new sessions lead
 * the list, that they survive a fresh read (persistence), and that a missing id
 * fails with the typed error. The slug rule is checked only via `session.branch`.
 */
describe("SessionStore", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  let repoPath: string
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("jingler-repos-")
    repoPath = initGitRepo(join(repos.dir, "trigify-app"))
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const services = Layer.mergeAll(SessionStore.Default, GitService.Default)

  const input = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
    repoPath,
    repoName: "trigify-app",
    title: "Fix Login Bug!",
    cli: "claude",
    baseBranch: "main",
    ...over
  })

  /**
   * The store is one JSON file rewritten wholesale, so concurrent mutations
   * race: each reads the array, edits its own session, writes the WHOLE thing
   * back, and the later write discards the earlier one's change.
   *
   * These use ONE service instance (`Effect.provide` once, around the whole
   * concurrent block) because the semaphore lives on the instance — providing
   * the layer per call would hand each fibre its own lock and test nothing.
   */
  describe("concurrent writers", () => {
    it("does not lose a session when two are created at once", async () => {
      const result = await runExit(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* Effect.all(
            [store.create(input({ title: "Alpha" })), store.create(input({ title: "Beta" }))],
            { concurrency: 2 }
          )
          return yield* store.list()
        }).pipe(Effect.provide(services)),
        temp.layer
      )

      expect(result._tag).toBe("Success")
      if (result._tag !== "Success") return
      // Both survive. Unserialised, the second create appends to a list read
      // before the first existed, and Alpha vanishes.
      expect(result.value.map((s) => s.title).sort()).toEqual(["Alpha", "Beta"])
    })

    it("does not lose a concurrent update while a session is being deleted", async () => {
      const result = await runExit(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const doomed = yield* store.create(input({ title: "Doomed" }))
          const keeper = yield* store.create(input({ title: "Keeper" }))
          // `remove` shells out to git for seconds; a write landing in that
          // window was previously discarded by a list captured before it.
          yield* Effect.all([store.remove(doomed.id), store.setModel(keeper.id, "opus")], {
            concurrency: 2
          })
          return yield* store.list()
        }).pipe(Effect.provide(services)),
        temp.layer
      )

      expect(result._tag).toBe("Success")
      if (result._tag !== "Success") return
      expect(result.value.map((s) => s.title)).toEqual(["Keeper"])
      expect(activeChat(result.value[0]!).model).toBe("opus")
    })
  })

  /**
   * A slug becomes a directory name, and most filesystems cap one name at 255
   * bytes. Issue and PR titles have no such limit, so an unbounded slug made
   * `git worktree add` fail with ENAMETOOLONG and lost the create outright.
   */
  it("caps a very long title so the worktree path stays creatable", async () => {
    const exit = await runExit(
      SessionStore.create(input({ title: "a very long title ".repeat(40) })).pipe(
        Effect.provide(services)
      ),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    // MAX_SLUG (100) plus the "-<base36 stamp>" suffix. Pinned tightly rather
    // than to a round number, so raising the cap has to be a deliberate edit
    // here too.
    expect(basename(exit.value.worktreePath!).length).toBeLessThanOrEqual(100 + 1 + 12)
    // Truncation must not leave a trailing dash on the branch name.
    expect(exit.value.branch).not.toMatch(/-$/)
    expect(existsSync(exit.value.worktreePath!)).toBe(true)
  })

  /**
   * `createWorktree` reclaims whatever sits at the target path with an `rm -rf`,
   * so a slug collision against a LIVE session would delete that session's
   * worktree and everything uncommitted in it. `createFromPr` and
   * `createFromIssue` already refused that; `create` did not.
   *
   * The guard is defence-in-depth and cannot be provoked through this API — a
   * `create` slug always carries a unique stamp. What IS worth pinning is the
   * property that makes it safe: two identically-titled sessions get distinct
   * worktrees and BOTH survive, so the guard never fires as a false positive on
   * the ordinary path.
   */
  it("gives two identically-titled sessions distinct worktrees, and keeps both", async () => {
    const first = await runExit(
      SessionStore.create(input({ title: "Same Name" })).pipe(Effect.provide(services)),
      temp.layer
    )
    const second = await runExit(
      SessionStore.create(input({ title: "Same Name" })).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(first._tag).toBe("Success")
    expect(second._tag).toBe("Success")
    if (first._tag !== "Success" || second._tag !== "Success") return
    expect(first.value.worktreePath).not.toBe(second.value.worktreePath)
    // The first session's worktree was NOT reclaimed out from under it.
    expect(existsSync(first.value.worktreePath!)).toBe(true)
    expect(existsSync(second.value.worktreePath!)).toBe(true)
  })

  it("creates an idle session with a jingler/<slug> branch and a worktree path", async () => {
    const exit = await runExit(
      SessionStore.create(input()).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const s = exit.value
    expect(s.status).toBe("idle")
    // The slug folds in a unique stamp so auto-named sessions never collide.
    expect(s.branch).toMatch(/^jingler\/fix-login-bug-[a-z0-9]+$/)
    expect(s.baseBranch).toBe("main")
    expect(s.worktreePath).toMatch(
      new RegExp(`${join(temp.root, "worktrees", "trigify-app")}/fix-login-bug-[a-z0-9]+$`)
    )
    // An explicit title is pinned (the agent won't auto-overwrite it).
    expect(s.autoTitle).toBe(false)
    expect(s.title).toBe("Fix Login Bug!")
    expect(s.diff).toStrictEqual({ added: 0, removed: 0 })
  })

  it("persists chat create, rename, selection, and adjacent close fallback", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const created = yield* SessionStore.create(input({ title: "Multi chat" }), {
          defaultMode: "auto",
          defaultModel: "opus"
        })
        const firstChatId = created.activeChatId
        const withSecond = yield* SessionStore.createChat(created.id)
        const secondChatId = withSecond.activeChatId
        yield* SessionStore.renameChat(created.id, secondChatId, "Review migrations")
        yield* SessionStore.selectChat(created.id, firstChatId)
        const selected = yield* SessionStore.get(created.id)
        yield* SessionStore.closeChat(created.id, firstChatId)
        const closed = yield* SessionStore.get(created.id)
        yield* SessionStore.closeChat(created.id, secondChatId)
        const replaced = yield* SessionStore.get(created.id)
        return { firstChatId, secondChatId, selected, closed, replaced }
      }).pipe(Effect.provide(services)),
      temp.layer
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.selected.activeChatId).toBe(exit.value.firstChatId)
    expect(exit.value.closed.chats.map((chat) => chat.title)).toStrictEqual([
      "Review migrations"
    ])
    expect(exit.value.closed.activeChatId).toBe(exit.value.secondChatId)
    expect(exit.value.replaced.chats).toHaveLength(1)
    expect(exit.value.replaced.chats[0]!.title).toBeNull()
    expect(exit.value.replaced.activeChatId).toBe(exit.value.replaced.chats[0]!.id)
    expect(exit.value.replaced.activeChatId).not.toBe(exit.value.secondChatId)
    expect(exit.value.replaced.chats[0]!.mode).toBe("auto")
    expect(exit.value.replaced.chats[0]!.model).toBe("opus")
  })

  it("stamps provider mode, model, and reasoning defaults when supplied", async () => {
    const withDefaults = await runExit(
      SessionStore.create(input(), {
        defaultMode: "plan",
        defaultModel: "opus",
        defaultReasoning: { enabled: false, effort: "high" }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(withDefaults._tag).toBe("Success")
    if (withDefaults._tag === "Success") {
      expect(activeChat(withDefaults.value).mode).toBe("plan")
      expect(activeChat(withDefaults.value).model).toBe("opus")
      expect(withDefaults.value.reasoning?.claude).toStrictEqual({
        enabled: false,
        effort: "high"
      })
    }

    const noDefaults = await runExit(
      SessionStore.create(input({ title: "No Defaults" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(noDefaults._tag).toBe("Success")
    if (noDefaults._tag === "Success") {
      expect(activeChat(noDefaults.value).mode).toBeUndefined()
      expect(activeChat(noDefaults.value).model).toBeUndefined()
      expect(noDefaults.value.reasoningEffort).toBeUndefined()
    }
  })

  it("moves legacy context occupancy onto the synthesized first chat", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: "Legacy context" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const {
      chats: _chats,
      activeChatId: _activeChatId,
      ...legacy
    } = created.value
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([{ ...legacy, contextTokens: 190_000 }])
    )

    const reread = await runExit(
      SessionStore.get(created.value.id).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(reread._tag).toBe("Success")
    if (reread._tag !== "Success") return
    expect(activeChat(reread.value).contextTokens).toBe(190_000)
  })

  /**
   * The pure-function cases live in `migrateRepoName`'s own describe. This one
   * exists to pin the WIRING: drop the call from `readAll` and every one of
   * those still passes while the sidebar silently regains its phantom group.
   */
  it("re-derives a stale repo name when reading sessions.json", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: "Renamed repo" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return

    // Rewrite the file the way a rename leaves it: `repoPath` still correct,
    // `repo` still holding the directory's old name.
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([{ ...created.value, repo: "old-name" }])
    )

    const reread = await runExit(
      SessionStore.get(created.value.id).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(reread._tag).toBe("Success")
    if (reread._tag !== "Success") return
    expect(reread.value.repo).toBe(basename(repoPath))
    expect(reread.value.repo).not.toBe("old-name")
  })

  it("keeps normal and Gigaplan resume ids independent", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const created = yield* SessionStore.create(input({ title: "Two threads" }))
        yield* SessionStore.setResumeId(created.id, "normal-thread")
        yield* SessionStore.setGigaplanResumeId(created.id, "intake-thread")
        yield* SessionStore.setReasoningEffort(created.id, "ultrathink")
        const configured = yield* SessionStore.get(created.id)
        yield* SessionStore.setReasoningEffort(created.id, undefined)
        const cleared = yield* SessionStore.get(created.id)
        return { configured, cleared }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(activeChat(exit.value.configured).resumeId).toBe("normal-thread")
    expect(activeChat(exit.value.configured).gigaplanResumeId).toBe("intake-thread")
    expect(exit.value.configured.reasoning?.claude).toStrictEqual({
      enabled: true,
      effort: "xhigh"
    })
    expect(activeChat(exit.value.cleared).resumeId).toBe("normal-thread")
    expect(activeChat(exit.value.cleared).gigaplanResumeId).toBe("intake-thread")
    expect(exit.value.cleared.reasoning?.claude).toBeUndefined()
  })

  it("falls back to the 'session' slug when the title has no alphanumerics", async () => {
    const exit = await runExit(
      SessionStore.create(input({ title: "!!!" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.branch).toMatch(/^jingler\/session-[a-z0-9]+$/)
  })

  it("stages an untitled session in a detached friendly-named worktree", async () => {
    const exit = await runExit(
      SessionStore.create(input({ title: undefined })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.title).toBe("Untitled session")
    expect(exit.value.autoTitle).toBe(true)
    expect(basename(exit.value.worktreePath ?? "")).toMatch(/^[a-z]+-[a-z]+$/)
    const live = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: exit.value.worktreePath,
      encoding: "utf-8"
    }).trim()
    expect(live).toBe("HEAD")
  })

  it("gives two blank sessions distinct worktrees while both remain detached", async () => {
    const created = await runExit(
      Effect.gen(function* () {
        const a = yield* SessionStore.create(input({ title: undefined }))
        const b = yield* SessionStore.create(input({ title: undefined }))
        return [a, b] as const
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const [a, b] = created.value
    expect(a.id).not.toBe(b.id)
    expect(a.worktreePath).not.toBe(b.worktreePath)
    for (const session of [a, b]) {
      expect(
        execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: session.worktreePath,
          encoding: "utf-8"
        }).trim()
      ).toBe("HEAD")
    }
  })

  it("setTitle changes only the title; renameTitle also pins it — branch/id/worktree stay put", async () => {
    const result = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.create(input({ title: undefined }))
        yield* SessionStore.setTitle(s.id, "Rate limit the API")
        const afterAuto = yield* SessionStore.get(s.id)
        yield* SessionStore.renameTitle(s.id, "My pinned name")
        const afterRename = yield* SessionStore.get(s.id)
        return { s, afterAuto, afterRename }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    const { s, afterAuto, afterRename } = result.value
    // setTitle updated the title but nothing structural.
    expect(afterAuto.title).toBe("Rate limit the API")
    expect(afterAuto.autoTitle).toBe(true)
    expect(afterAuto.branch).toBe(s.branch)
    expect(afterAuto.id).toBe(s.id)
    expect(afterAuto.worktreePath).toBe(s.worktreePath)
    expect(afterAuto.baseBranch).toBe(s.baseBranch)
    // renameTitle pinned it.
    expect(afterRename.title).toBe("My pinned name")
    expect(afterRename.autoTitle).toBe(false)
    expect(afterRename.branch).toBe(s.branch)
  })

  it("prepends new sessions and persists them across a fresh read", async () => {
    const created = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.create(input({ title: "First" }))
        yield* SessionStore.create(input({ title: "Second" }))
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")

    // Fresh provide → reads sessions.json from disk (proves persistence).
    const listed = await runExit(
      SessionStore.list().pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(listed._tag).toBe("Success")
    if (listed._tag === "Success") {
      expect(listed.value.map((s) => s.title)).toStrictEqual(["Second", "First"])
    }
  })

  it("fails with SessionNotFoundError for an unknown id", async () => {
    const exit = await runExit(
      SessionStore.get("s_nope").pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("SessionNotFoundError")
  })

  it("setPrNumber links (and clears) a session's PR across a fresh read", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const created = yield* SessionStore.create(input({ title: "PR Session" }))
        yield* SessionStore.setPrNumber(created.id, 482)
        return created.id
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const id = exit.value

    const linked = await runExit(
      SessionStore.get(id).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(linked._tag === "Success" && linked.value.prNumber).toBe(482)

    // Clearing it (null) round-trips too.
    const cleared = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.setPrNumber(id, null)
        return yield* SessionStore.get(id)
      }).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(cleared._tag === "Success" && cleared.value.prNumber).toBe(null)
  })

  it("setMode / setModel persist onto the session across a fresh read", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const created = yield* SessionStore.create(input({ title: "Configurable" }))
        yield* SessionStore.setMode(created.id, "auto")
        yield* SessionStore.setModel(created.id, "sonnet")
        return created.id
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const reread = await runExit(
      SessionStore.get(exit.value).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(reread._tag).toBe("Success")
    if (reread._tag === "Success") {
      expect(activeChat(reread.value).mode).toBe("auto")
      expect(activeChat(reread.value).model).toBe("sonnet")
    }
  })

  /**
   * Switching harness is not just a field write. `resumeId` holds the PREVIOUS
   * harness's thread id — handing a Codex thread id to Claude would resume
   * something unrelated or error — and `plan` mode is Claude-only. Both must be
   * reconciled atomically with the switch, or the next turn runs wrong.
   */
  /**
   * Context accounting has to survive a restart. Until now `tokens` was written
   * as `0` at creation and never touched again, while the real reading lived only
   * in renderer state — so a session reopened at 290k read as 0 and would happily
   * run to the hard ceiling before anything noticed.
   */
  describe("setContextTokens / clearResumeId", () => {
    it("persists the latest context reading across a fresh read", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Long Runner" }))
          yield* SessionStore.setContextTokens(created.id, 290_000)
          return created.id
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      // Fresh provide → reads sessions.json from disk, i.e. survives a restart.
      const reread = await runExit(
        SessionStore.get(exit.value).pipe(Effect.provide(SessionStore.Default)),
        temp.layer
      )
      expect(reread._tag).toBe("Success")
      if (reread._tag !== "Success") return
      expect(reread.value.contextTokens).toBe(290_000)
    })

    // A LATEST reading, never a high-water mark: compaction legitimately shrinks
    // it, and that drop is the signal the feature worked.
    it("lets the reading fall, because compaction is supposed to shrink it", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Compacted" }))
          yield* SessionStore.setContextTokens(created.id, 290_000)
          yield* SessionStore.setContextTokens(created.id, 12_000)
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.contextTokens).toBe(12_000)
    })

    it("ignores a garbage reading rather than persisting NaN", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Garbage" }))
          yield* SessionStore.setContextTokens(created.id, 5_000)
          yield* SessionStore.setContextTokens(created.id, Number.NaN)
          yield* SessionStore.setContextTokens(created.id, -1)
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.contextTokens).toBe(5_000)
    })

    // How compaction reseeds: drop the harness thread, keep everything else. The
    // transcript on disk is deliberately untouched.
    it("drops the resume id so the next turn starts a fresh conversation", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Reseeded" }))
          yield* SessionStore.setResumeId(created.id, "thread_abc")
          yield* SessionStore.clearResumeId(created.id)
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(activeChat(exit.value).resumeId).toBeUndefined()
      // The session itself is otherwise intact — only the thread pointer went.
      expect(exit.value.title).toBe("Reseeded")
      expect(exit.value.cli).toBe("claude")
    })
  })

  describe("setHarness", () => {
    it("keeps the resume id when only the model changes", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Switcher" }))
          yield* SessionStore.setResumeId(created.id, "thread_from_claude")
          yield* SessionStore.setHarness(created.id, "claude", "haiku")
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(activeChat(exit.value).model).toBe("haiku")
      expect(exit.value.cli).toBe("claude")
      // Same harness → the thread is still valid, so continuation must survive.
      expect(activeChat(exit.value).resumeId).toBe("thread_from_claude")
    })

    it("drops the resume id when the harness changes", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Switcher" }))
          yield* SessionStore.setResumeId(created.id, "thread_from_claude")
          yield* SessionStore.setHarness(created.id, "codex", "gpt-5.6-sol")
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.cli).toBe("codex")
      expect(activeChat(exit.value).model).toBe("gpt-5.6-sol")
      expect(activeChat(exit.value).resumeId).toBeUndefined()
    })

    it("normalizes every chat when the session-wide harness changes", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Multi switch" }), {
            defaultMode: "plan",
            defaultModel: "sonnet"
          })
          yield* SessionStore.setResumeId(created.id, created.activeChatId, "claude-one")
          const withSecond = yield* SessionStore.createChat(created.id)
          yield* SessionStore.setResumeId(created.id, withSecond.activeChatId, "claude-two")
          yield* SessionStore.setHarness(
            created.id,
            withSecond.activeChatId,
            "cursor",
            "composer-1"
          )
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.cli).toBe("cursor")
      expect(exit.value.chats.map((chat) => chat.resumeId)).toStrictEqual([
        undefined,
        undefined
      ])
      expect(exit.value.chats.map((chat) => chat.mode)).toStrictEqual(["ask", "ask"])
      expect(exit.value.chats.map((chat) => chat.model)).toStrictEqual([
        undefined,
        "composer-1"
      ])
    })

    /**
     * Codex holds a plan turn through the fenced ` ```plan ` block, so switching
     * to it mid-plan is no longer a downgrade. Coercing here would have thrown
     * away the operator's in-flight planning session for no reason.
     */
    it("keeps plan mode when switching to another harness that can plan", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Switcher" }))
          yield* SessionStore.setMode(created.id, "plan")
          yield* SessionStore.setHarness(created.id, "codex", "gpt-5.6-sol")
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(activeChat(exit.value).mode).toBe("plan")
    })

    /**
     * Cursor has no real adapter — it falls through to the scripted stub — so a
     * "plan" it produced would be fabricated. Handing the runner a mode the new
     * harness cannot honour is exactly what this coercion exists to prevent.
     */
    it("coerces plan mode when switching to a harness that cannot plan", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Switcher" }))
          yield* SessionStore.setMode(created.id, "plan")
          yield* SessionStore.setHarness(created.id, "cursor", "composer-1")
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(activeChat(exit.value).mode).toBe("ask")
    })

    it("leaves plan mode alone when staying on Claude", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Switcher" }))
          yield* SessionStore.setMode(created.id, "plan")
          yield* SessionStore.setHarness(created.id, "claude", "opus")
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(activeChat(exit.value).mode).toBe("plan")
    })

    it("does not disturb a non-plan mode on switch", async () => {
      const exit = await runExit(
        Effect.gen(function* () {
          const created = yield* SessionStore.create(input({ title: "Switcher" }))
          yield* SessionStore.setMode(created.id, "auto")
          yield* SessionStore.setHarness(created.id, "codex", "gpt-5.6-sol")
          return yield* SessionStore.get(created.id)
        }).pipe(Effect.provide(services)),
        temp.layer
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(activeChat(exit.value).mode).toBe("auto")
    })
  })

  // `createFromPr` orchestrates real GitService (worktree add) + GhService
  // (`gh pr checkout`). `gh` isn't available in CI and the fork isn't real, so we
  // drive both binaries with a fake executor overlaid on the real temp FS: the
  // worktree dir + sessions.json are real, only the git/gh *processes* are canned.
  const prServices = Layer.mergeAll(
  SessionStore.Default,
  GitService.Default,
  GhService.Default
)

  const prInput = (over: Partial<CreateSessionFromPrInput["pr"]> = {}): CreateSessionFromPrInput => ({
    repoPath,
    repoName: "trigify-app",
    cli: "claude",
    pr: { number: 482, title: "Fix Auth Refresh", headRefName: "chore/bump", baseRefName: "main", ...over }
  })

  /** Fake git/gh: record the argv, echo `headBranch` for rev-parse. */
  const prExecutor = (headBranch: string, calls: Array<string>): FakeCommandHandler => (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`)
    if (cmd === "gh") return { stdout: "" }
    if (cmd === "git" && args.includes("rev-parse")) return { stdout: headBranch }
    return { exitCode: 0, stdout: "" }
  }

  it("createFromPr checks out the PR head branch and links the PR number", async () => {
    const calls: Array<string> = []
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(prExecutor("chore/bump", calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput()).pipe(Effect.provide(prServices)),
      env
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const s = exit.value
    expect(s.prNumber).toBe(482)
    expect(s.branch).toBe("chore/bump") // the live branch after `gh pr checkout`
    expect(s.baseBranch).toBe("main")
    expect(s.title).toBe("Fix Auth Refresh")
    // The slug carries the PR number so same-titled PRs never collide.
    expect(s.worktreePath).toBe(join(temp.root, "worktrees", "trigify-app", "fix-auth-refresh-482"))

    // Sequence: detached worktree → gh pr checkout → resolve the head branch.
    const detach = calls.findIndex((c) => c.includes("worktree add --detach"))
    const checkout = calls.findIndex((c) => c.startsWith("gh pr checkout 482"))
    const revparse = calls.findIndex(
      (c, index) => index > checkout && c.includes("rev-parse")
    )
    expect(detach).toBeGreaterThanOrEqual(0)
    expect(checkout).toBeGreaterThan(detach)
    expect(revparse).toBeGreaterThan(checkout)

    // Persisted across a fresh read.
    const reread = await runExit(
      SessionStore.get(s.id).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(reread._tag === "Success" && reread.value.prNumber).toBe(482)
  })

  it("createFromPr gives same-titled PRs DISTINCT worktrees (slug carries the PR number)", async () => {
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(prExecutor("chore/bump", [])))
    // Two different PRs that happen to share a title.
    const first = await runExit(
      SessionStore.createFromPr(prInput({ number: 101, title: "Update deps" })).pipe(Effect.provide(prServices)),
      env
    )
    const second = await runExit(
      SessionStore.createFromPr(prInput({ number: 202, title: "Update deps" })).pipe(Effect.provide(prServices)),
      env
    )
    expect(first._tag).toBe("Success")
    expect(second._tag).toBe("Success")
    if (first._tag !== "Success" || second._tag !== "Success") return
    // Distinct worktree paths + ids — the second PR is NOT refused as a duplicate.
    expect(first.value.worktreePath).toBe(join(temp.root, "worktrees", "trigify-app", "update-deps-101"))
    expect(second.value.worktreePath).toBe(join(temp.root, "worktrees", "trigify-app", "update-deps-202"))
    expect(first.value.worktreePath).not.toBe(second.value.worktreePath)
    expect(first.value.id).not.toBe(second.value.id)
  })

  it("createFromPr falls back to the PR head ref when HEAD is detached", async () => {
    const calls: Array<string> = []
    // "HEAD" (detached) → branchAt yields null → the reported head ref is used.
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(prExecutor("HEAD", calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput({ headRefName: "feat/from-fork" })).pipe(
        Effect.provide(prServices)
      ),
      env
    )
    expect(exit._tag === "Success" && exit.value.branch).toBe("feat/from-fork")
  })

  it("createFromPr fails with GhError when `gh pr checkout` fails", async () => {
    const handler: FakeCommandHandler = (cmd, args) =>
      cmd === "gh" && args[1] === "checkout" ? { exitCode: 1, stderr: "gh: no such PR" } : { stdout: "" }
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(handler))
    const exit = await runExit(
      SessionStore.createFromPr(prInput()).pipe(Effect.provide(prServices)),
      env
    )
    expect(failureOf(exit)?._tag).toBe("GhError")
  })

  // When the PR head branch is already checked out elsewhere, `gh pr checkout`
  // fails with git's "already checked out" error. The share-checked-out lever
  // decides whether to fall back to a shared checkout or surface the error.
  const alreadyCheckedOut = (calls: Array<string>): FakeCommandHandler => (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`)
    if (cmd === "gh" && args[1] === "checkout") {
      return { exitCode: 1, stderr: "fatal: 'chore/bump' is already checked out at '/repo'" }
    }
    if (cmd === "git" && args.includes("rev-parse")) return { stdout: "chore/bump" }
    return { exitCode: 0, stdout: "" }
  }

  it("createFromPr falls back to a shared checkout when allowSharedCheckout is on", async () => {
    const calls: Array<string> = []
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(alreadyCheckedOut(calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput(), { allowSharedCheckout: true }).pipe(
        Effect.provide(prServices)
      ),
      env
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.branch).toBe("chore/bump")
    // It retried with the ignore-other-worktrees checkout after gh failed.
    expect(calls.some((c) => c.includes("checkout --ignore-other-worktrees chore/bump"))).toBe(true)
  })

  it("archive sets archived + reason + archivedAt; restore clears them", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: "Archive Me" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const id = created.value.id

    const archived = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.archive(id, "merged")
        return yield* SessionStore.get(id)
      }).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(archived._tag).toBe("Success")
    if (archived._tag === "Success") {
      expect(archived.value.archived).toBe(true)
      expect(archived.value.archiveReason).toBe("merged")
      expect(typeof archived.value.archivedAt).toBe("string")
    }

    const restored = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.restore(id)
        return yield* SessionStore.get(id)
      }).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(restored._tag).toBe("Success")
    if (restored._tag === "Success") {
      expect(restored.value.archived).toBe(false)
      expect(restored.value.archiveReason).toBeUndefined()
    }
  })

  it("remove deletes the session record and its worktree", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: "Delete Me" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const worktreePath = created.value.worktreePath!
    expect(existsSync(worktreePath)).toBe(true)

    const removed = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.remove(created.value.id)
        return yield* SessionStore.list()
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(removed._tag).toBe("Success")
    if (removed._tag === "Success") {
      expect(removed.value.some((s) => s.id === created.value.id)).toBe(false)
    }
    // The worktree was removed from disk + unregistered in the origin repo.
    expect(existsSync(worktreePath)).toBe(false)
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(worktrees).not.toContain(worktreePath)
  })

  it("remove preserves commits made before an untitled session is retitled", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: undefined })).pipe(Effect.provide(services)),
      temp.layer
    )
    if (created._tag !== "Success") throw new Error("expected session")
    const worktreePath = created.value.worktreePath!
    const rescueBranch = `jingler/${basename(worktreePath)}`
    writeFileSync(join(worktreePath, "work.ts"), "saved\n")
    execFileSync("git", ["add", "work.ts"], { cwd: worktreePath })
    execFileSync("git", ["commit", "-m", "detached work", "--no-gpg-sign"], {
      cwd: worktreePath
    })
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf-8"
    }).trim()

    const removed = await runExit(
      SessionStore.remove(created.value.id).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(removed._tag).toBe("Success")
    expect(existsSync(worktreePath)).toBe(false)
    expect(
      execFileSync("git", ["rev-parse", rescueBranch], {
        cwd: repoPath,
        encoding: "utf-8"
      }).trim()
    ).toBe(head)
  })

  it("createFromPr surfaces the error when allowSharedCheckout is off", async () => {
    const calls: Array<string> = []
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(alreadyCheckedOut(calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput(), { allowSharedCheckout: false }).pipe(
        Effect.provide(prServices)
      ),
      env
    )
    expect(failureOf(exit)?._tag).toBe("GhError")
    expect(calls.some((c) => c.includes("--ignore-other-worktrees"))).toBe(false)
  })

  // `createFromIssue` forks a FRESH branch (like `create`) but keys the slug on
  // the issue number, links the issue, seeds the task, and turns on automations.
  // No GhService needed — it never touches the network.
  const issueInput = (
    over: Partial<CreateSessionFromIssueInput> = {}
  ): CreateSessionFromIssueInput => ({
    repoPath,
    repoName: "trigify-app",
    cli: "claude",
    baseBranch: "main",
    issue: {
      number: 128,
      title: "Refund route 500s on a stale token",
      url: "https://github.com/acme/api/issues/128",
      body: "Fix the refund route.",
      labels: [{ name: "bug", color: "e06c75" }]
    },
    task: "",
    automations: { progressComments: true, closeOnMerge: true },
    ...over
  })

  it("createFromIssue forks a jingler/<n>-slug branch, links the issue, seeds the task", async () => {
    const exit = await runExit(
      SessionStore.createFromIssue(issueInput()).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const s = exit.value
    expect(s.branch).toBe("jingler/128-refund-route-500s-on-a-stale-token")
    expect(s.issueNumber).toBe(128)
    expect(s.issueUrl).toBe("https://github.com/acme/api/issues/128")
    expect(s.issueTitle).toBe("Refund route 500s on a stale token")
    expect(s.issueLabels).toStrictEqual([{ name: "bug", color: "e06c75" }])
    expect(s.automations).toStrictEqual({ progressComments: true, closeOnMerge: true })
    // Title pinned from the issue; task falls back to title + body.
    expect(s.title).toBe("Refund route 500s on a stale token")
    expect(s.autoTitle).toBe(false)
    expect(s.initialPrompt).toBe("Refund route 500s on a stale token\n\nFix the refund route.")
    expect(s.prNumber).toBe(null)
  })

  it("createFromIssue prefers the edited task over the issue body", async () => {
    const exit = await runExit(
      SessionStore.createFromIssue(issueInput({ task: "Just fix the 401 retry guard." })).pipe(
        Effect.provide(services)
      ),
      temp.layer
    )
    expect(exit._tag === "Success" && exit.value.initialPrompt).toBe("Just fix the 401 retry guard.")
  })

  it("createFromIssue refuses a second session for the same issue", async () => {
    const twice = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.createFromIssue(issueInput())
        return yield* SessionStore.createFromIssue(issueInput())
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(failureOf(twice)?._tag).toBe("GitError")
  })

  it("setIssue links then unlinks; clearInitialPrompt drops the one-shot prompt", async () => {
    const result = await runExit(
      Effect.gen(function* () {
        const s = yield* SessionStore.createFromIssue(issueInput())
        yield* SessionStore.clearInitialPrompt(s.id)
        const cleared = yield* SessionStore.get(s.id)
        yield* SessionStore.setIssue(s.id, null)
        const unlinked = yield* SessionStore.get(s.id)
        return { cleared, unlinked }
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    const { cleared, unlinked } = result.value
    expect(cleared.initialPrompt).toBeUndefined()
    expect(unlinked.issueNumber).toBeUndefined()
    expect(unlinked.automations).toBeUndefined()
  })
})

/**
 * `repo` is a denormalised copy of the repo's folder name, and the sidebar
 * groups on it. Renaming a repo directory used to split one repo across two
 * headings — the old name holding every session that predated the rename, the
 * new name holding only what came after.
 */
describe("migrateRepoName", () => {
  const at = (repoPath: string | undefined, repo: string) => {
    const migrated = migrateRepoName({ id: "s1", repo, ...(repoPath === undefined ? {} : { repoPath }) })
    return (migrated as { repo: string }).repo
  }

  it("re-derives the name from repoPath after a rename", () => {
    expect(at("/Users/x/repos/jingler", "starbase")).toBe("jingler")
  })

  it("leaves an already-correct name untouched", () => {
    expect(at("/Users/x/repos/jingler", "jingler")).toBe("jingler")
  })

  it("keeps the stored name when there is no repoPath to derive from", () => {
    // Sessions predating `repoPath` — a stale group heading beats no heading.
    expect(at(undefined, "starbase")).toBe("starbase")
    expect(at("", "starbase")).toBe("starbase")
    expect(at("   ", "starbase")).toBe("starbase")
  })

  it("keeps the stored name rather than deriving an empty one", () => {
    // `basename("/")` is "", which would render as a blank group heading.
    expect(at("/", "starbase")).toBe("starbase")
  })

  it("preserves a directory name that contains dots", () => {
    // A real repo in this workspace: the whole basename is the name, and
    // splitting on "." would silently rename it.
    expect(at("/Users/x/repos/trigify-app.feat-signal", "old")).toBe("trigify-app.feat-signal")
  })

  it("is idempotent — re-reading an already-migrated file changes nothing", () => {
    const once = migrateRepoName({ id: "s1", repo: "starbase", repoPath: "/Users/x/repos/jingler" })
    expect(migrateRepoName(once)).toEqual(once)
  })

  it("passes non-records straight through", () => {
    expect(migrateRepoName(null)).toBe(null)
    expect(migrateRepoName("nope")).toBe("nope")
  })

  it("leaves every other field alone", () => {
    const migrated = migrateRepoName({
      id: "s1",
      repo: "starbase",
      repoPath: "/Users/x/repos/jingler",
      branch: "starbase/fix-auth",
      worktreePath: "/Users/x/jingler/worktrees/jingler/fix-auth"
    }) as Record<string, unknown>
    // The BRANCH keeps its old prefix on purpose: it is a real git ref with an
    // open PR attached, and renaming it here would orphan both.
    expect(migrated.branch).toBe("starbase/fix-auth")
    expect(migrated.worktreePath).toBe("/Users/x/jingler/worktrees/jingler/fix-auth")
    expect(migrated.id).toBe("s1")
  })
})

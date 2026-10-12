import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, expect, it } from "vitest"
import { GitService, ProjectService, SessionStore } from "@jingler/cli-adapters"
import { initGitRepo, withTempRoot } from "../../../../packages/cli-adapters/src/test-support.js"
import { importSession, scanImportableSessions } from "./rpc.js"

const NATIVE_ID = "shared-native-id"
let temp: ReturnType<typeof withTempRoot>
let originalHome: string | undefined

const writeJsonl = (file: string, lines: ReadonlyArray<unknown>) => {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n"))
}

beforeEach(() => {
  temp = withTempRoot()
  originalHome = process.env.HOME
  const home = join(temp.root, "home")
  // os.homedir() reads $HOME on POSIX; importSession uses it to find the native stores.
  process.env.HOME = home
  // Separate repos: direct sessions are limited to one per repository.
  const claudeCwd = initGitRepo(join(temp.root, "claude-project"))
  const codexCwd = initGitRepo(join(temp.root, "codex-project"))
  writeJsonl(join(home, ".claude", "projects", "p", `${NATIVE_ID}.jsonl`), [
    { type: "user", sessionId: NATIVE_ID, cwd: claudeCwd, gitBranch: "main", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello claude" } }
  ])
  writeJsonl(join(home, ".codex", "sessions", "2026", "01", "01", `rollout-${NATIVE_ID}.jsonl`), [
    { timestamp: "2026-01-02T00:00:00Z", type: "session_meta", payload: { id: NATIVE_ID, cwd: codexCwd, git: { branch: "main" } } },
    { timestamp: "2026-01-02T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } }
  ])
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  temp.cleanup()
})

// R is generic because importSession's requirements are all satisfied by the layers below.
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise((effect as Effect.Effect<A, E, never>).pipe(
    Effect.provide(Layer.mergeAll(SessionStore.Default, ProjectService.Default, GitService.Default)),
    Effect.provide(temp.layer)
  ))

it("importing the same source + native id twice yields one session", async () => {
  const { first, second, all } = await run(Effect.gen(function* () {
    const first = yield* importSession("claude-code", NATIVE_ID)
    const second = yield* importSession("claude-code", NATIVE_ID)
    return { first, second, all: yield* SessionStore.list() }
  }))
  expect(second.id).toBe(first.id)
  expect(all).toHaveLength(1)
})

it("the same native id from a different source creates a second session", async () => {
  const { claude, codex, all } = await run(Effect.gen(function* () {
    const claude = yield* importSession("claude-code", NATIVE_ID)
    const codex = yield* importSession("codex", NATIVE_ID)
    return { claude, codex, all: yield* SessionStore.list() }
  }))
  expect(codex.id).not.toBe(claude.id)
  expect(all).toHaveLength(2)
})

it("the created session records importedFrom {source, nativeSessionId}", async () => {
  const stored = await run(Effect.gen(function* () {
    const created = yield* importSession("codex", NATIVE_ID)
    return yield* SessionStore.get(created.id)
  }))
  expect(stored.importedFrom).toEqual({ source: "codex", nativeSessionId: NATIVE_ID })
})

it("scanImportable marks only the already-imported source's candidate", async () => {
  const scanned = await run(Effect.gen(function* () {
    yield* importSession("claude-code", NATIVE_ID)
    return yield* scanImportableSessions()
  }))
  const bySource = Object.fromEntries(scanned.map(s => [s.source, s.alreadyImported]))
  expect(bySource).toEqual({ "claude-code": true, codex: false })
})

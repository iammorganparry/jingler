import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  type StreamEvent
} from "@jingler/core"
import { Effect, Layer, Schema, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AgentTurnDriver } from "./agent-turn-driver.js"
import type { AgentTurnDriverShape } from "./agent-turn-driver.js"
import { ConfigService } from "./config.js"
import { InMemorySecretStoreLive } from "./secret-store.js"
import { OpenConnectorService } from "./open-connector.js"
import { AgentRunner } from "./agent-runner.js"
import { ContextManager } from "./context-manager.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { PlanStore } from "./plan-store.js"
import { withTempRoot } from "./test-support.js"
import { BrowserControlMcpService } from "./browser-control-mcp-service.js"

/** Browser hosting is independent of unsettled-run instrumentation. */
const BrowserControlMcpServiceTest = Layer.succeed(
  BrowserControlMcpService,
  BrowserControlMcpService.of({
    acquire: () => Effect.succeed(null),
    revoke: () => Effect.void
  })
)

/**
 * Instrumentation for turns that end without settling.
 *
 * A turn's `streaming` flag is cleared by exactly two events — `Done` and
 * `Failed`. A run that emits neither leaves the turn spinning in the live UI
 * forever, which is the "turn died and never responded" report. It looks
 * self-healing because `settleStreaming()` wipes stale flags on transcript
 * re-read, so reloading destroys the evidence.
 *
 * These tests pin the recorder, not a fix: the trigger in the wild is still
 * unknown, and the record is what should identify it.
 */

let temp: ReturnType<typeof withTempRoot>
const TEST_RUNTIME = {
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("test-connection"),
  providerId: Schema.decodeUnknownSync(ProviderId)("anthropic"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-test")
} as const

beforeEach(() => {
  temp = withTempRoot()
  mkdirSync(temp.root, { recursive: true })
  const now = "2026-07-24T00:00:00.000Z"
  writeFileSync(
    join(temp.root, "sessions.json"),
    JSON.stringify([{
      id: SESSION,
      repo: "widget",
      branch: "chore/unsettled",
      title: "Unsettled",
      status: "idle",
      cli: "claude",
      ...TEST_RUNTIME,
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: now,
      worktreePath: temp.root,
      chats: [{ id: SESSION, title: null, createdAt: now, updatedAt: now, ...TEST_RUNTIME }],
      activeChatId: SESSION
    }])
  )
})
afterEach(() => temp.cleanup())

const SESSION = "s_unsettled"
const UnsettledTurnRecord = Schema.Struct({
  at: Schema.String,
  sessionId: Schema.String,
  providerId: Schema.NullOr(Schema.String),
  images: Schema.Number,
  events: Schema.Number,
  lastEvent: Schema.NullOr(Schema.String),
  exitInterrupted: Schema.Boolean
})
type UnsettledTurnRecord = Schema.Schema.Type<typeof UnsettledTurnRecord>
const decodeUnsettledTurnRecord = Schema.decodeUnknownSync(
  Schema.parseJson(UnsettledTurnRecord)
)

/** An adapter that says something and then just stops — no `Done`, no `Failed`. */
const silentExitAdapter: Layer.Layer<AgentTurnDriver> = Layer.succeed(
  AgentTurnDriver,
  AgentTurnDriver.of({
    run: (_sessionId, _spec, ctx) =>
      Effect.gen(function* () {
        yield* ctx.emit({ _tag: "Assistant", text: "half an answer" })
      }) as ReturnType<AgentTurnDriverShape["run"]>,
    stop: () => Effect.void
  })
)

/** The healthy path, for contrast: the same run, properly terminated. */
const settlingAdapter: Layer.Layer<AgentTurnDriver> = Layer.succeed(
  AgentTurnDriver,
  AgentTurnDriver.of({
    run: (_sessionId, _spec, ctx) =>
      Effect.gen(function* () {
        yield* ctx.emit({ _tag: "Assistant", text: "a whole answer" })
        yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
      }) as ReturnType<AgentTurnDriverShape["run"]>,
    stop: () => Effect.void
  })
)

const run = (adapter: Layer.Layer<AgentTurnDriver>) => {
  const base = Layer.mergeAll(
    AgentRunner.Default,
    OpenConnectorService.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
    ConfigService.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    PlanStore.Default,
    adapter,
    ContextManager.Default,
    temp.layer
  )
  const program = Effect.gen(function* () {
    const runner = yield* AgentRunner
    const events: Array<StreamEvent> = []
    yield* runner
      .prompt(SESSION, SESSION, "go")
      .pipe(Stream.runForEach((ev) => Effect.sync(() => events.push(ev))))
    const transcript = yield* TranscriptStore.list(SESSION)
    return { events, transcript }
  })
  return Effect.runPromise(program.pipe(Effect.provide(base)))
}

const records = (): ReadonlyArray<UnsettledTurnRecord> => {
  const file = join(temp.root, "unsettled-turns.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => decodeUnsettledTurnRecord(line))
}

describe("AgentRunner unsettled-turn instrumentation", () => {
  it("records a run that ends without a terminal event", async () => {
    await run(silentExitAdapter)
    expect(records()).toHaveLength(1)
  })

  /**
   * The whole point of the record: enough to tell the candidate causes apart
   * without needing to reproduce the turn.
   */
  it("captures which session and how far the run got", async () => {
    await run(silentExitAdapter)
    const [rec] = records()
    expect(rec!.sessionId).toBe(SESSION)
    expect(rec!.lastEvent).toBe("Assistant")
    expect(rec!.exitInterrupted).toBe(false)
  })

  /**
   * The symptom the record is standing in for. Without a terminal event the
   * persisted turn keeps `streaming: true`, which is what leaves it spinning.
   */
  it("corresponds to a turn left marked streaming", async () => {
    const { transcript } = await run(silentExitAdapter)
    const assistant = transcript.find((m) => m.role === "assistant")
    expect(assistant!.streaming).toBe(true)
  })

  it("stays silent when the run terminates properly", async () => {
    const { transcript } = await run(settlingAdapter)
    expect(records()).toHaveLength(0)
    expect(transcript.find((m) => m.role === "assistant")!.streaming).toBe(false)
  })
})

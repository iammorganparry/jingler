import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  GateDecision,
  PermissionMode,
  Session,
  StreamEvent
} from "@jingler/core"
import {
  AgentRunError,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  STOPPED_NOTE
} from "@jingler/core"
import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream, TestClock, TestContext } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AgentTurnDriver,
  makeScriptedAgentTurnDriver,
} from "./agent-turn-driver.js"
import type {
  AgentTurnDriverShape,
  PermissionDecision,
  AgentTurnSpec
} from "./agent-turn-driver.js"
import { ConfigService } from "./config.js"
import {
  InMemorySecretStoreLive,
} from "./secret-store.js"
import {
  AgentRunner,
  isContextOverflowFailure,
} from "./agent-runner.js"
import { ContextManager } from "./context-manager.js"
import { SessionStore } from "./sessions.js"
import { TranscriptStore } from "./transcripts.js"
import { BackgroundTaskStore } from "./background-tasks.js"
import { reserveSessionRun } from "./run-coordinator.js"
import { initGitRepo, withTempRoot } from "./test-support.js"
import {
  BrowserControlMcpService,
  type BrowserControlMcpAttachment
} from "./browser-control-mcp-service.js"

const PREVIEW_MCP: BrowserControlMcpAttachment = {
  name: "jingler-browser",
  url: "http://127.0.0.1:32123/mcp",
  headers: { Authorization: "Bearer preview-secret" },
  headerEnvironment: { Authorization: "JINGLER_BROWSER_MCP_AUTHORIZATION" }
}
const browserAcquireCalls: Array<{ readonly sessionId: string; readonly chatId: string; readonly ownerId: string }> = []
const TEST_RUNTIME = {
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("test-connection"),
  providerId: Schema.decodeUnknownSync(ProviderId)("anthropic"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-test")
} as const

/** Main-only Preview attachment normally owned by the app-scoped listener. */
const BrowserControlMcpServiceTest = Layer.succeed(
  BrowserControlMcpService,
  BrowserControlMcpService.of({
    acquire: (sessionId, chatId, ownerId) =>
      Effect.sync(() => {
        browserAcquireCalls.push({ sessionId, chatId, ownerId })
        return PREVIEW_MCP
      }),
    revoke: () => Effect.void
  })
)

/**
 * The runner is the harness-agnostic HITL core. We assert on OUTCOMES the
 * operator observes — which tools ran, which paused for approval, and what got
 * persisted — driving it through the deterministic scripted adapter (delay 0).
 * We never assert on the adapter's internal steps.
 */

let temp: ReturnType<typeof withTempRoot>

beforeEach(() => {
  browserAcquireCalls.length = 0
  temp = withTempRoot()
  mkdirSync(temp.root, { recursive: true })
  const now = "2026-07-24T00:00:00.000Z"
  writeFileSync(
    join(temp.root, "sessions.json"),
    JSON.stringify([{
      id: SESSION,
      repo: "widget",
      branch: "chore/test",
      title: "Test",
      status: "idle",
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
afterEach(() => {
  vi.unstubAllGlobals()
  temp.cleanup()
})

const SESSION = "s_test"

const chatForSession = (
  updatedAt: string,
  fields: Partial<Session["chats"][number]> = {}
): Session["chats"][number] => ({
  id: SESSION,
  title: null,
  createdAt: updatedAt,
  updatedAt,
  ...TEST_RUNTIME,
  ...fields
})

/** Run one prompt, auto-answering every gate with `decision`; collect events + transcript. */
const runPrompt = (mode: PermissionMode, decision: GateDecision) => {
  const base = Layer.mergeAll(
    AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
    ConfigService.Default,
    SessionStore.Default,
    TranscriptStore.Default,
    BackgroundTaskStore.Default,
    makeScriptedAgentTurnDriver(0),
    ContextManager.Default,
    temp.layer
  )
  const program = Effect.gen(function* () {
    const runner = yield* AgentRunner
    yield* runner.setMode(SESSION, mode)
    const events: Array<StreamEvent> = []
    yield* runner.prompt(SESSION, SESSION, "Add rate limiting to the refund endpoint.").pipe(
      Stream.tap((ev) =>
        ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, decision) : Effect.void
      ),
      Stream.runForEach((ev) => Effect.sync(() => events.push(ev)))
    )
    const transcript = yield* TranscriptStore.list(SESSION)
    return { events, transcript }
  })
  return Effect.runPromise(program.pipe(Effect.provide(base)))
}

const gates = (events: ReadonlyArray<StreamEvent>) =>
  events.filter((e): e is Extract<StreamEvent, { _tag: "GateRequested" }> => e._tag === "GateRequested")

const ranTool = (events: ReadonlyArray<StreamEvent>, id: string) =>
  events.some((e) => e._tag === "ToolStart" && e.id === id)


describe("isContextOverflowFailure", () => {
  it("recognises Codex and API context exhaustion without matching ordinary failures", () => {
    expect(
      isContextOverflowFailure(
        "Codex ran out of room in the model's context window. Start a new thread."
      )
    ).toBe(true)
    expect(isContextOverflowFailure("maximum context length exceeded")).toBe(true)
    expect(isContextOverflowFailure("Claude authentication failed")).toBe(false)
  })
})

describe("AgentRunner session completion", () => {
  it.each(["background", "sibling"] as const)("blocks completion while %s work is live", async (blocker) => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let calls = 0
      const adapter = Layer.succeed(AgentTurnDriver, AgentTurnDriver.of({
        run: (_sessionId, _spec, ctx) => Effect.gen(function* () {
          if (blocker === "sibling" && calls++ === 0) {
            yield* Deferred.succeed(started, undefined)
            yield* Effect.never
          }
          if (blocker === "background") yield* ctx.emit({
            _tag: "BackgroundTaskStarted", id: "completion-blocker",
            description: "Pending work", taskType: "bash", subagentType: null, toolUseId: null
          })
          yield* ctx.emit({ _tag: "SessionCompletionDeclared" })
          yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }),
        stop: () => Effect.void
      }))
      const base = Layer.mergeAll(
        AgentRunner.Default, BrowserControlMcpServiceTest, InMemorySecretStoreLive,
        ConfigService.Default, SessionStore.Default, TranscriptStore.Default,
        BackgroundTaskStore.Default, adapter, ContextManager.Default, temp.layer
      )
      yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        if (blocker === "sibling") {
          const sibling = yield* SessionStore.createChat(SESSION)
          yield* Effect.fork(runner.prompt(SESSION, sibling.activeChatId, "pending").pipe(Stream.runDrain))
          yield* Deferred.await(started)
        }
        const events = yield* runner.prompt(SESSION, SESSION, "finish").pipe(
          Stream.takeUntil((event) => event._tag === "Done"), Stream.runCollect
        )
        expect(Array.from(events).some((event) => event._tag === "SessionSettled")).toBe(false)
        expect((yield* SessionStore.get(SESSION)).status).toBe("idle")
        yield* runner.stop(SESSION)
      }).pipe(Effect.provide(base))
    }).pipe(Effect.timeout("10 seconds")))
  })

  it("settles only after an explicit declaration and successful terminal event", async () => {
    let declare = false
    const adapter = Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, _spec, ctx) => Effect.gen(function* () {
          if (declare) yield* ctx.emit({ _tag: "SessionCompletionDeclared" })
          yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      BrowserControlMcpServiceTest,
      InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      adapter,
      ContextManager.Default,
      temp.layer
    )

    await Effect.runPromise(Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.prompt(SESSION, SESSION, "partial").pipe(Stream.runDrain)
      expect((yield* SessionStore.get(SESSION)).status).toBe("idle")
      declare = true
      const events = yield* runner.prompt(SESSION, SESSION, "finish").pipe(Stream.runCollect)
      expect(Array.from(events).some((event) => event._tag === "SessionSettled")).toBe(true)
      expect((yield* SessionStore.get(SESSION)).status).toBe("settled")
    }).pipe(Effect.provide(base)))
  })
})

describe("AgentRunner remote MCP attachments", () => {
  it("supplies the Preview HTTP entry without persisting its bearer", async () => {
    const captured: AgentTurnSpec[] = []
    const recordingAdapter = Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, spec, ctx) =>
          Effect.sync(() => captured.push(spec)).pipe(
            Effect.zipRight(ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 }))
          ),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      BrowserControlMcpServiceTest,
      InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      recordingAdapter,
      ContextManager.Default,
      temp.layer
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, SESSION, "use both servers").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]!.prompt).toContain("<managed-tools>")
    expect(browserAcquireCalls).toStrictEqual([
      { sessionId: SESSION, chatId: SESSION, ownerId: `${SESSION}:${SESSION}` }
    ])
    expect(captured[0]!.mcp).toStrictEqual({ browser: PREVIEW_MCP })
    const persistedSession = readFileSync(join(temp.root, "sessions.json"), "utf8")
    expect(persistedSession).not.toContain("preview-secret")
    expect(persistedSession).not.toContain("remoteMcpServers")
  })
})

describe("AgentRunner HITL gating", () => {
  it("accept-edits: applies edits without a gate, but pauses for a command", async () => {
    const { events } = await runPrompt("accept-edits", "allow")
    const g = gates(events)
    expect(g).toHaveLength(1)
    expect(g[0]!.gate.kind).toBe("command")
    expect(ranTool(events, "edit-1")).toBe(true) // edit auto-applied
    expect(ranTool(events, "bash-1")).toBe(true) // command ran after approval
  })

  it("ask: pauses for BOTH the edit and the command", async () => {
    const { events } = await runPrompt("ask", "allow")
    const g = gates(events)
    expect(g.map((x) => x.gate.kind)).toStrictEqual(["edit", "command"])
    expect(ranTool(events, "edit-1")).toBe(true)
    expect(ranTool(events, "bash-1")).toBe(true)
  })

  it("auto: runs everything with no gates at all", async () => {
    const { events } = await runPrompt("auto", "deny")
    expect(gates(events)).toHaveLength(0)
    expect(ranTool(events, "edit-1")).toBe(true)
    expect(ranTool(events, "bash-1")).toBe(true)
  })

  /**
   * An adapter that asks permission for one command and one edit, then ends.
   * The scripted adapter can't be used here: in plan mode it proposes a plan and
   * blocks on the decision instead of running tools.
   */
  const probeAdapter = (out: {
    command: PermissionDecision | null
    edit: PermissionDecision | null
  }): Layer.Layer<AgentTurnDriver> =>
    Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, _spec, ctx) =>
          Effect.gen(function* () {
            out.command = yield* ctx.canUseTool({
              kind: "command",
              tool: "Bash",
              target: null,
              command: "git log --oneline -5"
            })
            out.edit = yield* ctx.canUseTool({
              kind: "edit",
              tool: "Edit",
              target: "src/auth/session.ts",
              command: null
            })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<AgentTurnDriverShape["run"]>,
        stop: () => Effect.void
      })
    )

  const probe = (mode: PermissionMode) => {
    const out: { command: PermissionDecision | null; edit: PermissionDecision | null } = {
      command: null,
      edit: null
    }
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      probeAdapter(out),
      ContextManager.Default,
      temp.layer
    )
    return Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, mode)
        yield* runner.prompt(SESSION, SESSION, "how does auth work?").pipe(
          // Deny anything that does gate, so a gate is visible as a denial rather
          // than a hang.
          Stream.tap((ev) =>
            ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, "deny") : Effect.void
          ),
          Stream.runDrain
        )
      }).pipe(Effect.provide(base))
    ).then(() => out)
  }

  it("plan: a command runs unattended (planning cannot write), an edit still gates", async () => {
    // Planning reads — `git log`, `rg`, `gh pr view`. Gating those trained the
    // operator to click "allow" on actions that cannot change anything.
    expect(await probe("plan")).toStrictEqual({ command: "allow", edit: "deny" })
  })

  it("ask: the same command still gates", async () => {
    expect(await probe("ask")).toStrictEqual({ command: "deny", edit: "deny" })
  })

  it("denying the command gate leaves it unrun", async () => {
    const { events } = await runPrompt("accept-edits", "deny")
    expect(gates(events)).toHaveLength(1)
    expect(ranTool(events, "bash-1")).toBe(false) // command was denied
    expect(events.some((e) => e._tag === "Assistant" && e.text.includes("unrun"))).toBe(true)
  })

  it("persists the transcript as a user turn + a completed assistant turn", async () => {
    const { transcript } = await runPrompt("auto", "allow")
    expect(transcript).toHaveLength(2)
    expect(transcript[0]!.role).toBe("user")
    const assistant = transcript[1]!
    expect(assistant.role).toBe("assistant")
    expect(assistant.streaming).toBe(false)
    // The applied edit's tool card is persisted with its diff.
    const toolPart = assistant.parts.find((p) => p._tag === "Tool" && p.tool.id === "edit-1")
    expect(toolPart && toolPart._tag === "Tool" && toolPart.tool.diff).toStrictEqual({ added: 7, removed: 0 })
  })
})

describe("AgentRunner sub-agents", () => {
  // An adapter that emits a main line, then a sub-agent's whole lifecycle, then done.
  const subagentAdapter: Layer.Layer<AgentTurnDriver> = Layer.succeed(
    AgentTurnDriver,
    AgentTurnDriver.of({
      run: (_sessionId, _spec, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit({ _tag: "Assistant", text: "main output" })
          yield* ctx.emit({
            _tag: "SubagentStarted",
            id: "task_1",
            name: "Explore",
            description: "sub task",
            parentId: null
          })
          yield* ctx.emit({ _tag: "Assistant", text: "SUBTEXT", agentId: "task_1" })
          yield* ctx.emit({ _tag: "ToolStart", id: "r1", name: "Read", target: "a.ts", agentId: "task_1" })
          yield* ctx.emit({ _tag: "SubagentEnded", id: "task_1", status: "done" })
          yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }) as ReturnType<AgentTurnDriverShape["run"]>,
      stop: () => Effect.void
    })
  )

  /**
   * An adapter that models a HELD-OPEN turn: the main agent finishes talking, its
   * `Done` is withheld while the sub-agent works on,
   * and only the sub-agent's bookend releases it.
   *
   * The gap is where the bug used to live. With the `Done` emitted early the
   * renderer left `running`, the stream's scope closed, and `runLifetime` reaped the
   * fiber — aborting the one SDK query every sub-agent ran inside. Here the terminal
   * event comes LAST, so the runner must carry the whole sub-agent lifecycle to the
   * consumer and settle exactly once at the end.
   */
  const heldTurnAdapter: Layer.Layer<AgentTurnDriver> = Layer.succeed(
    AgentTurnDriver,
    AgentTurnDriver.of({
      run: (_sessionId, _spec, ctx) =>
        Effect.gen(function* () {
          yield* ctx.emit({ _tag: "Assistant", text: "delegating" })
          yield* ctx.emit({
            _tag: "SubagentStarted",
            id: "task_1",
            name: "Explore",
            description: "sub task",
            parentId: null
          })
          // The main agent's own `result` would land about here. Nothing terminal
          // is emitted, and the sub-agent goes on reporting across the gap.
          yield* Effect.sleep("20 millis")
          yield* ctx.emit({ _tag: "Assistant", text: "LATE", agentId: "task_1" })
          yield* Effect.sleep("20 millis")
          yield* ctx.emit({ _tag: "SubagentEnded", id: "task_1", status: "done" })
          yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }) as ReturnType<AgentTurnDriverShape["run"]>,
      stop: () => Effect.void
    })
  )

  const runSubagentPrompt = (adapter: Layer.Layer<AgentTurnDriver> = subagentAdapter) => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      adapter,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "auto")
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, SESSION, "fan out").pipe(Stream.runForEach((ev) => Effect.sync(() => events.push(ev))))
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, transcript }
    })
    return Effect.runPromise(program.pipe(Effect.provide(base)))
  }

  it("surfaces sub-agent events downstream but keeps them out of the persisted main turn", async () => {
    const { events, transcript } = await runSubagentPrompt()

    // The renderer still receives the full sub-agent lifecycle.
    expect(events.some((e) => e._tag === "SubagentStarted" && e.id === "task_1")).toBe(true)
    expect(events.some((e) => e._tag === "SubagentEnded" && e.id === "task_1")).toBe(true)
    expect(events.some((e) => e._tag === "Assistant" && e.agentId === "task_1")).toBe(true)

    // But the persisted assistant turn contains ONLY the main output — no
    // sub-agent text and no sub-agent tool card leaked in.
    const assistant = transcript[1]!
    expect(assistant.role).toBe("assistant")
    const text = assistant.parts.filter((p) => p._tag === "Text").map((p) => (p as { text: string }).text).join("")
    expect(text).toContain("main output")
    expect(text).not.toContain("SUBTEXT")
    expect(assistant.parts.some((p) => p._tag === "Tool" && p.tool.id === "r1")).toBe(false)
  })

  it("carries a held-open turn's sub-agent events through to the consumer", async () => {
    // The regression. A turn whose `Done` is withheld while a sub-agent works must
    // not be truncated or reaped: the run is unsettled, so `runLifetime` keeps it on
    // `turn-in-flight` and every event after the main agent's last word still lands.
    const { events, transcript } = await runSubagentPrompt(heldTurnAdapter)

    const tags = events.map((e) => e._tag)
    expect(tags).toContain("SubagentEnded")
    expect(events.some((e) => e._tag === "Assistant" && e.agentId === "task_1")).toBe(true)

    // Ordering is the claim: the terminal event comes AFTER the sub-agent settled,
    // never before it.
    expect(tags.lastIndexOf("Done")).toBeGreaterThan(tags.indexOf("SubagentEnded"))
    expect(tags.filter((tag) => tag === "Done")).toHaveLength(1)
    expect(tags).not.toContain("Failed")

    // And the turn settles exactly once, with only the main agent's own words.
    const assistant = transcript[1]!
    const text = assistant.parts.filter((p) => p._tag === "Text").map((p) => (p as { text: string }).text).join("")
    expect(text).toContain("delegating")
    expect(text).not.toContain("LATE")
  })
})

describe("AgentRunner image attachments", () => {
  it("persists attached images on the user turn alongside the text", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      makeScriptedAgentTurnDriver(0),
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    const image = { id: "img1", name: "login.png", mediaType: "image/png", data: "aGVsbG8=" }
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "auto")
      yield* runner.prompt(SESSION, SESSION, "look at this", [image]).pipe(Stream.runDrain)
      return yield* TranscriptStore.list(SESSION)
    })
    const transcript = await Effect.runPromise(program.pipe(Effect.provide(base)))

    const user = transcript[0]!
    expect(user.role).toBe("user")
    // The image is persisted as an Image part, before the text part.
    const imagePart = user.parts.find((p) => p._tag === "Image")
    expect(imagePart && imagePart._tag === "Image" && imagePart.attachment).toStrictEqual(image)
    expect(user.parts.some((p) => p._tag === "Text" && p.text === "look at this")).toBe(true)
  })
})

describe("AgentRunner hidden prompt context", () => {
  it("persists display text instead of hidden context from the harness prompt", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
      BrowserControlMcpServiceTest,
      InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      makeScriptedAgentTurnDriver(0),
      ContextManager.Default,
      temp.layer
    )
    const fullPrompt = "Explain this\n\n<repository-code-references>hidden</repository-code-references>"
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "auto")
      yield* runner.prompt(
        SESSION,
        SESSION,
        fullPrompt,
        [],
        undefined,
        undefined,
        undefined,
        "Explain this"
      ).pipe(Stream.runDrain)
      return yield* TranscriptStore.list(SESSION)
    })
    const transcript = await Effect.runPromise(program.pipe(Effect.provide(base)))
    const visibleText = transcript[0]?.parts
      .filter((part) => part._tag === "Text")
      .map((part) => part.text)
      .join("")

    expect(visibleText).toBe("Explain this")
    expect(visibleText).not.toContain("repository-code-references")
  })
})

describe("AgentRunner AskUserQuestion", () => {
  it("emits QuestionRequested, resumes on answer, and records it in the transcript", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      makeScriptedAgentTurnDriver(0),
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, SESSION, "[[ask]] migrate the store").pipe(
        // Answer each question group as it arrives.
        Stream.tap((ev) =>
          ev._tag === "QuestionRequested"
            ? runner.answerQuestion(SESSION, ev.request.id, [
                { selected: ["Rotating refresh tokens"], other: null },
                { selected: ["HTTP middleware"], other: null }
              ])
            : Effect.void
        ),
        Stream.runForEach((e) => Effect.sync(() => events.push(e)))
      )
      const transcript = yield* TranscriptStore.list(SESSION)
      return { events, transcript }
    })
    const { events, transcript } = await Effect.runPromise(program.pipe(Effect.provide(base)))

    // The run paused for a question and then completed.
    expect(events.some((e) => e._tag === "QuestionRequested")).toBe(true)
    expect(events.some((e) => e._tag === "Done")).toBe(true)
    // The transcript's question part carries the recorded answers (so a reload
    // won't re-show it as pending).
    const qpart = transcript.flatMap((m) => m.parts).find((p) => p._tag === "Question")
    expect(qpart).toBeDefined()
    if (qpart && qpart._tag === "Question") {
      expect(qpart.answers).not.toBeNull()
      expect(qpart.answers?.[0]?.selected).toStrictEqual(["Rotating refresh tokens"])
    }
  })
})

describe("AgentRunner ids", () => {
  // The id counter is in-memory (resets on app restart) but the transcript
  // persists — so a run after a restart must not re-emit colliding ids, which
  // would make the virtualized transcript stack rows keyed by id.
  it("does not reuse message ids across a runner restart", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      makeScriptedAgentTurnDriver(0),
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    // Each provide of AgentRunner.Default builds a fresh runner (fresh counter),
    // so two separate runs against the same temp root simulate a restart.
    const runOnce = (text: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runner = yield* AgentRunner
          yield* runner.setMode(SESSION, "auto")
          yield* runner.prompt(SESSION, SESSION, text).pipe(Stream.runDrain)
        }).pipe(Effect.provide(base))
      )

    await runOnce("first")
    await runOnce("second")

    const transcript = await Effect.runPromise(
      TranscriptStore.list(SESSION).pipe(Effect.provide(Layer.merge(TranscriptStore.Default, temp.layer)))
    )
    const ids = transcript.map((m) => m.id)
    expect(ids.length).toBeGreaterThan(2)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("AgentRunner allowlist", () => {
  it('"always allow" a command means the next run does not gate it', async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      makeScriptedAgentTurnDriver(0),
    ContextManager.Default,
    ConfigService.Default,
      temp.layer
    )
    const program = Effect.gen(function* () {
      const runner = yield* AgentRunner
      yield* runner.setMode(SESSION, "accept-edits")

      // First run: "always allow" the command gate.
      yield* runner.prompt(SESSION, SESSION, "first").pipe(
        Stream.tap((ev) =>
          ev._tag === "GateRequested" ? runner.decideGate(SESSION, ev.gate.id, "always") : Effect.void
        ),
        Stream.runDrain
      )

      // Second run: the same command should now run without any gate.
      const events: Array<StreamEvent> = []
      yield* runner.prompt(SESSION, SESSION, "second").pipe(
        Stream.runForEach((ev) => Effect.sync(() => events.push(ev)))
      )
      return events
    })
    const events = await Effect.runPromise(program.pipe(Effect.provide(base)))
    expect(gates(events)).toHaveLength(0)
    expect(ranTool(events, "bash-1")).toBe(true)
  })
})

describe("AgentRunner model", () => {
  // Provider metadata must not replace the certified model selected for the run.
  const modelReportingAdapter = Layer.succeed(
    AgentTurnDriver,
    AgentTurnDriver.of({
      run: (sessionId, _spec, ctx) =>
        ctx
          .emit({ _tag: "Started", sessionId, model: "opus-live" })
          .pipe(Effect.zipRight(ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 }))),
      stop: () => Effect.void
    })
  )

  it("uses a switched model on the next turn without dropping continuation", async () => {
    const selected = {
      connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("openai-connection"),
      providerId: Schema.decodeUnknownSync(ProviderId)("openai-codex"),
      modelId: Schema.decodeUnknownSync(ProviderModelId)("openai-codex/gpt-test")
    }
    const captured: AgentTurnSpec[] = []
    const recordingAdapter = Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, spec, ctx) =>
          Effect.sync(() => captured.push(spec)).pipe(
            Effect.zipRight(ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 }))
          ),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      BrowserControlMcpServiceTest,
      InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      recordingAdapter,
      ContextManager.Default,
      temp.layer
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        const store = yield* SessionStore
        const setProviderModel = store.setProviderModel
        const writeStarted = yield* Deferred.make<void>()
        const releaseWrite = yield* Deferred.make<void>()
        vi.spyOn(store, "setProviderModel").mockImplementation((...args) =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.zipRight(Deferred.await(releaseWrite)),
            Effect.zipRight(setProviderModel(...args))
          )
        )
        yield* SessionStore.setPiSessionId(SESSION, SESSION, "pi-existing")

        const switchFiber = yield* Effect.fork(
          runner.setModel(
            SESSION,
            SESSION,
            selected.connectionId,
            selected.providerId,
            selected.modelId
          )
        )
        yield* Deferred.await(writeStarted)
        const promptFiber = yield* Effect.fork(
          runner.prompt(SESSION, SESSION, "continue").pipe(Stream.runDrain)
        )
        yield* Effect.sleep("10 millis")
        expect(captured).toHaveLength(0)

        yield* Deferred.succeed(releaseWrite, undefined)
        yield* Fiber.join(switchFiber)
        yield* Fiber.join(promptFiber)
      }).pipe(Effect.provide(base))
    )

    expect(captured[0]).toMatchObject({
      connectionId: selected.connectionId,
      modelId: selected.modelId,
      piSessionId: "pi-existing"
    })
  })

  it("does not replace the certified model id with provider event metadata", async () => {
    const session: Session = {
      id: SESSION,
      repo: "r",
      branch: "b",
      title: "t",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-11T10:00:00.000Z",
      chats: [chatForSession("2026-07-11T10:00:00.000Z")],
      activeChatId: SESSION
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))

    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      modelReportingAdapter,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    const persistedModelId = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, SESSION, "hi").pipe(Stream.runDrain)
        const persisted = yield* SessionStore.get(SESSION)
        return persisted.chats.find((chat) => chat.id === persisted.activeChatId)?.modelId
      }).pipe(Effect.provide(base))
    )
    expect(persistedModelId).toBe("anthropic/claude-test")
  })
})

describe("AgentRunner resume across restarts", () => {
  const seedBareSession = () => {
    const session: Session = {
      id: SESSION,
      repo: "acme/widget",
      branch: "b",
      title: "t",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-07-11T10:00:00.000Z",
      chats: [chatForSession("2026-07-11T10:00:00.000Z", { mode: "auto" })],
      activeChatId: SESSION,
      mode: "auto"
    }
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "sessions.json"), JSON.stringify([session]))
  }

  // A driver that records the pi session id it was handed and reports the next
  // persistent pi identity on Started.
  const resumeAdapter = (
    captured: { piSessionId: string | null },
    nextPiSessionId: string
  ): Layer.Layer<AgentTurnDriver> =>
    Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, spec, ctx) =>
          Effect.gen(function* () {
            captured.piSessionId = spec.piSessionId
            yield* ctx.emit({ _tag: "Started", sessionId: nextPiSessionId })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
          }) as ReturnType<AgentTurnDriverShape["run"]>,
        stop: () => Effect.void
      })
    )

  it("persists the pi session id and resumes it after restart", async () => {
    seedBareSession()
    const captured: { piSessionId: string | null } = { piSessionId: null }
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      resumeAdapter(captured, "sdk-123"),
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )

    // First run: no prior pi session id; the runtime reports "sdk-123" on Started.
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner.prompt(SESSION, SESSION, "start").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    expect(captured.piSessionId).toBeNull()

    // It was persisted on the session (survives an app restart).
    const persisted = await Effect.runPromise(
      SessionStore.get(SESSION).pipe(Effect.provide(Layer.merge(SessionStore.Default, temp.layer)))
    )
    expect(
      persisted.chats.find((chat) => chat.id === persisted.activeChatId)?.piSessionId
    ).toBe("sdk-123")

    // A SECOND run through a FRESH runner (= a restart, empty in-memory map) picks
    // the id up from persistence and hands it to pi.
    captured.piSessionId = null
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.prompt(SESSION, SESSION, "continue").pipe(Stream.runDrain)
      }).pipe(Effect.provide(base))
    )
    expect(captured.piSessionId).toBe("sdk-123")
  })
})

describe("AgentRunner failures", () => {
  it("refuses a direct turn after the shared checkout moves to another branch", async () => {
    const repoPath = initGitRepo(join(temp.root, "direct-repo"), {
      branches: ["feature/other"]
    })
    const now = "2026-07-20T00:00:00.000Z"
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([
        {
          id: SESSION,
          repo: "direct-repo",
          branch: "main",
          title: "Direct",
          status: "idle",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          worktreePath: repoPath,
          repoPath,
          workspaceMode: "direct",
          chats: [chatForSession(now)],
          activeChatId: SESSION
        }
      ])
    )
    execFileSync("git", ["switch", "feature/other"], { cwd: repoPath })

    let adapterCalled = false
    const unusedAdapter = Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: () =>
          Effect.sync(() => {
            adapterCalled = true
          }),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      BrowserControlMcpServiceTest,
      InMemorySecretStoreLive,
      ConfigService.Default,
      ContextManager.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      unusedAdapter,
      temp.layer
    )

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        return yield* runner.prompt(SESSION, SESSION, "continue").pipe(Stream.runCollect)
      }).pipe(Effect.provide(base))
    )

    expect(adapterCalled).toBe(false)
    expect(Array.from(events)).toContainEqual({
      _tag: "BranchDrift",
      sessionId: SESSION,
      pinnedBranch: "main",
      liveBranch: "feature/other"
    })
  })

  it("stops a running direct turn as soon as its checkout changes branch", async () => {
    const repoPath = initGitRepo(join(temp.root, "live-direct-repo"), {
      branches: ["feature/other"]
    })
    const now = "2026-07-20T00:00:00.000Z"
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([
        {
          id: SESSION,
          repo: "live-direct-repo",
          branch: "main",
          title: "Live direct",
          status: "idle",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          worktreePath: repoPath,
          repoPath,
          workspaceMode: "direct",
          chats: [chatForSession(now)],
          activeChatId: SESSION
        }
      ])
    )
    const switchingAdapter = Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: () =>
          Effect.sync(() => {
            execFileSync("git", ["switch", "feature/other"], { cwd: repoPath })
          }).pipe(Effect.zipRight(Effect.never)),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
      BrowserControlMcpServiceTest,
      InMemorySecretStoreLive,
      ConfigService.Default,
      ContextManager.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      switchingAdapter,
      temp.layer
    )

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        return yield* runner
          .prompt(SESSION, SESSION, "continue")
          .pipe(Stream.runCollect)
      }).pipe(Effect.provide(base))
    )

    expect(Array.from(events)).toContainEqual({
      _tag: "BranchDrift",
      sessionId: SESSION,
      pinnedBranch: "main",
      liveBranch: "feature/other"
    })
  })

  it("surfaces an adapter's actionable failure instead of replacing it with a generic message", async () => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(
      join(temp.root, "sessions.json"),
      JSON.stringify([
        {
          id: SESSION,
          repo: "acme/widget",
          branch: "chore/auth",
          title: "Auth failure",
          status: "idle",
          ...TEST_RUNTIME,
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: "2026-07-20T00:00:00.000Z",
          worktreePath: temp.root,
          chats: [chatForSession("2026-07-20T00:00:00.000Z", { mode: "auto" })],
          activeChatId: SESSION,
          mode: "auto"
        }
      ])
    )
    const failingAdapter = Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: () =>
          Effect.fail(
            new AgentRunError({
              kind: "claude",
              message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
            })
          ),
        stop: () => Effect.void
      })
    )
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      ContextManager.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      failingAdapter,
      temp.layer
    )

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        return yield* runner.prompt(SESSION, SESSION, "hello").pipe(Stream.runCollect)
      }).pipe(Effect.provide(base))
    )

    expect(Array.from(events)).toContainEqual({
      _tag: "Failed",
      message: "Claude authentication failed. Run `claude auth login` in a terminal, then try again."
    })
  })
})

describe("AgentRunner stop", () => {
  /**
   * An agent that runs until something interrupts it. `started` fires once it's
   * really going, and `interrupted` once it's torn down — mirroring the real
   * Claude adapter, which aborts its CLI process in exactly such an `onInterrupt`
   * finalizer. That finalizer is the ONLY route to the process: `AgentTurnDriver.stop`
   * is a no-op in every implementation.
   */
  const hangingAdapter = (
    started: Deferred.Deferred<boolean>,
    interrupted: Deferred.Deferred<boolean>,
    gate?: { readonly wanted: boolean }
  ): Layer.Layer<AgentTurnDriver> =>
    Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, _spec, ctx) =>
          Effect.gen(function* () {
            yield* ctx.emit({ _tag: "Assistant", text: "working…" })
            yield* Deferred.succeed(started, true)
            // Optionally park on a gate, to cover the blocked-agent case.
            if (gate?.wanted) {
              yield* ctx.canUseTool({
                kind: "command",
                tool: "Bash",
                command: "sleep 600",
                target: null
              })
            }
            yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, true))) as ReturnType<
            AgentTurnDriverShape["run"]
          >,
        stop: () => Effect.void
      })
    )

  /**
   * A harness that SETTLES its turn and then stays alive.
   *
   * This is what a background task does to the real Claude adapter: its
   * `for await` over the SDK never breaks on `result`, so the run keeps consuming
   * long after `Done` in order to receive the task's `task_notification` bookend.
   * The turn is over; the fiber is not.
   */
  const BG_TASK = "bgtask_probe"

  const settledThenLingeringAdapter = (
    settled: Deferred.Deferred<boolean>,
    interrupted: Deferred.Deferred<boolean>
  ): Layer.Layer<AgentTurnDriver> =>
    Layer.succeed(
      AgentTurnDriver,
      AgentTurnDriver.of({
        run: (_sessionId, _spec, ctx) =>
          Effect.gen(function* () {
            // Register the stop handle the dock's button reaches, exactly as a real
            // adapter does: settling happens through the harness's own signals.
            yield* ctx.registerBackgroundStop((id) =>
              Effect.runPromise(
                ctx.emit({
                  _tag: "BackgroundTaskSettled",
                  id,
                  status: "stopped",
                  summary: "Stopped by the operator.",
                  outputFile: null
                })
              )
            )
            yield* ctx.emit({
              _tag: "BackgroundTaskStarted",
              id: BG_TASK,
              description: "Watching the test suite",
              taskType: "bash",
              subagentType: null,
              toolUseId: null
            })
            yield* ctx.emit({ _tag: "Assistant", text: "started a watcher" })
            yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
            yield* Deferred.succeed(settled, true)
            // The turn has settled. The harness lives on, servicing the task.
            yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, true))) as ReturnType<
            AgentTurnDriverShape["run"]
          >,
        stop: () => Effect.void
      })
    )

  /**
   * Drive a run to the point where the agent is genuinely working, then stop it.
   *
   * We wait on `started` rather than sleeping: `prompt` does real I/O (session
   * load, CLI discovery) before forking the run, so a fixed sleep races that
   * setup and stops before there is anything to interrupt.
   */
  const runAndStop = (opts: { readonly gate?: { readonly wanted: boolean } } = {}) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<boolean>()
      const base = Layer.mergeAll(
        AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        ConfigService.Default,
        hangingAdapter(started, interrupted, opts.gate),
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "ask")
        const events: Array<StreamEvent> = []
        // Consume in a fiber: this run never ends on its own.
        const consumer = yield* Effect.fork(
          runner
            .prompt(SESSION, SESSION, "go")
            .pipe(Stream.runForEach((ev) => Effect.sync(() => events.push(ev))))
        )
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        yield* runner.stop(SESSION)
        yield* Fiber.join(consumer).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        const wasInterrupted = yield* Deferred.await(interrupted).pipe(
          Effect.timeoutTo({ duration: "2 seconds", onTimeout: () => false, onSuccess: () => true })
        )
        return { wasInterrupted, events, transcript: yield* TranscriptStore.list(SESSION) }
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

  it("interrupts an agent that is mid-run and blocked on nothing", async () => {
    // The case a stop button exists for: the agent is streaming, waiting on
    // nobody. Denying pending gates — all `stop` used to do — is a no-op here.
    const { wasInterrupted } = await runAndStop()
    expect(wasInterrupted).toBe(true)
  })

  it("interrupts an agent parked on a gate", async () => {
    const { wasInterrupted } = await runAndStop({ gate: { wanted: true } })
    expect(wasInterrupted).toBe(true)
  })

  /**
   * Concurrent chats in a session are allowed, but a single chat is
   * single-flight. Two runs on ONE chatId would race the `fibers` slot (the
   * first fiber orphaned and unstoppable, since `stop` reads only the latest)
   * and mint colliding positional message ids from the same transcript
   * snapshot. A racing double-send on one chat must be refused, not admitted.
   */
  it("refuses a second run on a chat that is already running", async () => {
    const events = await Effect.gen(function* () {
      const started = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<boolean>()
      const base = Layer.mergeAll(
        AgentRunner.Default,
        BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        hangingAdapter(started, interrupted),
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        // First run hangs until interrupted; consume it in a fiber so it stays live.
        const first = yield* Effect.fork(
          runner.prompt(SESSION, SESSION, "go").pipe(Stream.runDrain)
        )
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        // Second prompt on the SAME chat, while the first is still running.
        const seen: Array<StreamEvent> = []
        yield* runner
          .prompt(SESSION, SESSION, "again")
          .pipe(Stream.runForEach((ev) => Effect.sync(() => seen.push(ev))))
        // Clean up the hanging first run.
        yield* runner.stop(SESSION)
        yield* Fiber.join(first).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    // The refused run emits exactly one terminal Failed event — nothing streamed.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      _tag: "Failed",
      message: expect.stringContaining("already running")
    })
  })

  /**
   * Background work must outlive the turn that started it.
   *
   * The run used to be forked into the REQUEST stream's scope, and the renderer
   * leaves `running` the moment `Done` lands — so detaching killed the harness at
   * turn end, every time. The dock went on listing the task as "running" with the
   * process servicing it already dead, and its stop button addressed a handle into
   * nothing. Backgrounding is the one feature that is defined by outliving a turn,
   * so this is the whole thing working or not.
   */
  it("keeps the harness alive after the renderer detaches, while a task runs", async () => {
    const alive = await Effect.gen(function* () {
      const settled = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<boolean>()
      const base = Layer.mergeAll(
        AgentRunner.Default,
        BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        settledThenLingeringAdapter(settled, interrupted),
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        // Consume exactly as the renderer does: stop at the terminal event.
        yield* runner
          .prompt(SESSION, SESSION, "watch the tests")
          .pipe(
            Stream.takeUntil((ev) => ev._tag === "Done" || ev._tag === "Failed"),
            Stream.runCollect,
            Effect.timeout("10 seconds")
          )
        // Well past the drain supervisor's grace: if detaching were still fatal,
        // the interrupt would have landed by now.
        yield* Effect.sleep("7 seconds")
        const dead = yield* Deferred.isDone(interrupted)
        const tasks = yield* BackgroundTaskStore.list(SESSION)
        return { dead, running: tasks.filter((t) => t.status === "running").length }
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    expect(alive.dead).toBe(false)
    // And the dock's row is telling the truth: a live task with a live harness.
    expect(alive.running).toBe(1)
  }, 30_000)

  /**
   * ...and it must not linger once the work is done.
   *
   * The other half of the lifetime: a harness kept alive for a task that has
   * finished is an orphaned process holding a chat's slot. Settling the task is
   * what ends the run, so the two are the same decision.
   */
  it("ends the run once the last background task settles", async () => {
    const outcome = await Effect.gen(function* () {
      const settled = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<boolean>()
      const base = Layer.mergeAll(
        AgentRunner.Default,
        BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        settledThenLingeringAdapter(settled, interrupted),
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        yield* runner
          .prompt(SESSION, SESSION, "watch the tests")
          .pipe(
            Stream.takeUntil((ev) => ev._tag === "Done" || ev._tag === "Failed"),
            Stream.runCollect,
            Effect.timeout("10 seconds")
          )
        // Settle it the way the dock's stop button does — through the handle the
        // adapter registered, not by writing to the registry behind its back.
        yield* BackgroundTaskStore.stop(SESSION, BG_TASK)
        // The supervisor notices on its next poll and lets the harness go.
        return yield* Deferred.await(interrupted).pipe(
          Effect.timeout("15 seconds"),
          Effect.as("ended" as const),
          Effect.orElseSucceed(() => "still-running" as const)
        )
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    expect(outcome).toBe("ended")
  }, 30_000)

  /**
   * A settled turn must not hold the chat, however long its harness lives on.
   *
   * The refusal asks whether a run FIBER is alive. That is the wrong question once
   * a background task is in play: the real adapter keeps consuming the SDK after
   * `result` so the task's bookend can arrive, so the fiber outlives the turn by
   * however long the task runs. Every later prompt is then refused with "already
   * running" while the composer — which follows the machine, and went idle on
   * `Done` — shows a send button and nothing to stop. The right question is
   * whether a TURN is in flight.
   */
  it("admits a prompt once the turn has settled, even while the harness lives on", async () => {
    const events = await Effect.gen(function* () {
      const settled = yield* Deferred.make<boolean>()
      const interrupted = yield* Deferred.make<boolean>()
      const base = Layer.mergeAll(
        AgentRunner.Default,
        BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        settledThenLingeringAdapter(settled, interrupted),
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        // Keep consuming, exactly as a renderer does until it processes `Done`.
        const first = yield* Effect.fork(
          runner.prompt(SESSION, SESSION, "watch the tests").pipe(Stream.runDrain)
        )
        yield* Deferred.await(settled).pipe(Effect.timeout("5 seconds"))

        // Stop at the terminal event, exactly as the renderer does: a harness kept
        // alive by a background task never ends its stream on its own.
        const seen = Array.from(
          yield* runner
            .prompt(SESSION, SESSION, "summarise the repo")
            .pipe(
              Stream.takeUntil((ev) => ev._tag === "Done" || ev._tag === "Failed"),
              Stream.runCollect,
              Effect.timeout("10 seconds")
            )
        )
        yield* runner.stop(SESSION)
        yield* Fiber.join(first).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    expect(
      events.some((ev) => ev._tag === "Failed" && ev.message.includes("already running"))
    ).toBe(false)
  })

  /**
   * The other half of single-flight: a refusal must mean a run is ACTUALLY
   * live, not merely that one was once reserved.
   *
   * The reservation is released by a finalizer on the stream's scope, and a
   * renderer that dies without interrupting the stream (window reload, HMR full
   * reload, crash) never closes it. The main process — and the reservation map
   * — outlive the renderer, so the chat was refused forever, with no stop
   * button on the reloaded page to clear it. Killing the app was the only
   * recovery. A reservation with no live fiber is proof of exactly that, since
   * `fibers` is written under the same chat lock immediately after reserving.
   */
  it("reclaims a reservation stranded with no live run", async () => {
    const events = await Effect.gen(function* () {
      const base = Layer.mergeAll(
        AgentRunner.Default,
        BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        makeScriptedAgentTurnDriver(0),
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        // Strand a reservation the way an abandoned stream does: reserved, but
        // with no fiber ever registered against it.
        expect(yield* reserveSessionRun(SESSION, SESSION, {})).toBe(true)
        const seen: Array<StreamEvent> = []
        yield* runner
          .prompt(SESSION, SESSION, "go")
          .pipe(Stream.runForEach((ev) => Effect.sync(() => seen.push(ev))))
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    // The run proceeded rather than being refused.
    expect(events.some((ev) => ev._tag === "Failed" && ev.message.includes("already running"))).toBe(false)
    expect(events.length).toBeGreaterThan(0)
  })

  /**
   * The invariant behind the regression this change exists for.
   *
   * `stop` used to read a session's run by id alone, so an interrupt that landed
   * after the NEXT turn had been forked killed that turn instead — the
   * operator's fresh message came back as a bare "Stopped." and they re-sent it
   * (64 of 946 assistant turns in ~/jingler/transcripts are exactly this).
   *
   * Asserting the SYMPTOM cannot be done honestly: reproducing it needs the
   * stop's map read to be scheduled after the next run registers, which is a
   * timing construction, not a fact about the code — the same reason the
   * deregistration guard next to it is reviewed rather than pinned. What IS
   * deterministic is the ordering that makes the symptom impossible: a turn
   * cannot begin setup while a stop for that session is still in flight. Pin
   * that, and the race has nowhere to happen.
   *
   * Run A's teardown is made slow on purpose, so "did B wait?" is observable
   * rather than a coin toss.
   */
  it("holds the next turn until an in-flight stop has finished unwinding", async () => {
    const log = await Effect.gen(function* () {
      const started = yield* Deferred.make<boolean>()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (what: string) => Ref.update(order, (l) => [...l, what])
      const slowAdapter = Layer.succeed(
        AgentTurnDriver,
        AgentTurnDriver.of({
          run: (_sessionId, spec, ctx) =>
            (spec.prompt.includes("second")
              ? Effect.gen(function* () {
                  yield* note("B-setup-ran")
                  yield* ctx.emit({ _tag: "Assistant", text: "second" })
                  yield* ctx.emit({ _tag: "Done", costUsd: 0, tokens: 1 })
                })
              : Effect.gen(function* () {
                  yield* ctx.emit({ _tag: "Assistant", text: "first" })
                  yield* Deferred.succeed(started, true)
                  yield* Effect.never
                }).pipe(
                  // A real harness takes time to tear its child down; without
                  // that, "B waited" and "B raced and won" look identical.
                  Effect.onInterrupt(() => Effect.sleep("400 millis").pipe(Effect.zipRight(note("A-torn-down"))))
                )) as ReturnType<AgentTurnDriverShape["run"]>,
          stop: () => Effect.void
        })
      )
      const base = Layer.mergeAll(
        AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        slowAdapter,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "ask")
        yield* Effect.fork(runner.prompt(SESSION, SESSION, "first").pipe(Stream.runDrain))
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        // Forked, NOT awaited — this is how the renderer used to fire it, and
        // the whole point is that firing it that way must still be safe.
        yield* Effect.fork(runner.stop(SESSION))
        yield* Effect.sleep("50 millis")
        yield* runner.prompt(SESSION, SESSION, "second").pipe(Stream.runDrain, Effect.timeout("5 seconds"))
        return yield* Ref.get(order)
      }).pipe(Effect.provide(base))
    }).pipe(Effect.runPromise)

    expect(log).toEqual(["A-torn-down", "B-setup-ran"])
  })

  it("ends the stream and records the stop, rather than reporting a crash", async () => {
    const { events, transcript } = await runAndStop()
    // The stream must terminate — a consumer that never completes hangs the UI.
    expect(events.some((e) => e._tag === "Failed" && e.message === STOPPED_NOTE)).toBe(true)
    // The operator's own stop must not surface as "the agent run failed".
    expect(events.some((e) => e._tag === "Failed" && e.message.includes("failed"))).toBe(false)
    // And the turn settles, rather than streaming forever.
    expect(transcript[transcript.length - 1]!.streaming).toBe(false)
  })
})

/**
 * The other half of the silent-turn bug: a harness child that hangs before it
 * says anything at all.
 *
 * Nothing in the stack used to bound this. `drainRun` in the renderer only
 * synthesises a terminal event when the stream ENDS, `Effect.ensuring(out.end)`
 * only runs when `adapter.run` RETURNS, and the unsettled-turn instrumentation
 * is a finalizer — none of them can fire on a run that neither emits nor exits.
 * 32 of 946 assistant turns in ~/jingler/transcripts are frozen exactly there:
 * empty parts, `streaming: true`, and an eyebrow pulsing over nothing.
 */
describe("AgentRunner first-event watchdog", () => {
  it("settles a turn whose harness never says anything", async () => {
    const events = await Effect.gen(function* () {
      const entered = yield* Deferred.make<boolean>()
      const muteAdapter = Layer.succeed(
        AgentTurnDriver,
        AgentTurnDriver.of({
          run: () =>
            Effect.gen(function* () {
              // Signals that the run is live WITHOUT emitting — the case a
              // finalizer cannot see, because nothing ever ends.
              yield* Deferred.succeed(entered, true)
              yield* Effect.never
            }) as ReturnType<AgentTurnDriverShape["run"]>,
          stop: () => Effect.void
        })
      )
      const base = Layer.mergeAll(
        AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        muteAdapter,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        const seen: Array<StreamEvent> = []
        const consumer = yield* Effect.fork(
          runner.prompt(SESSION, SESSION, "hello?").pipe(Stream.runForEach((e) => Effect.sync(() => seen.push(e))))
        )
        // The watchdog is forked immediately before the adapter runs, so once
        // the adapter is live the sleep is registered and the clock can jump.
        yield* Deferred.await(entered)
        yield* TestClock.adjust("121 seconds")
        yield* Fiber.join(consumer).pipe(Effect.ignore)
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise)

    const failed = events.find((e) => e._tag === "Failed")
    expect(failed).toBeDefined()
    // Actionable, and NOT the bare "Stopped." — the operator did not do this.
    expect(failed).toMatchObject({ message: expect.stringContaining("produced no output") })
    expect(events.some((e) => e._tag === "Failed" && e.message === STOPPED_NOTE)).toBe(false)
  })

  it("leaves a slow but living turn alone", async () => {
    const events = await Effect.gen(function* () {
      const spoke = yield* Deferred.make<boolean>()
      const chattyAdapter = Layer.succeed(
        AgentTurnDriver,
        AgentTurnDriver.of({
          run: (_sessionId, _spec, ctx) =>
            Effect.gen(function* () {
              yield* ctx.emit({ _tag: "Assistant", text: "thinking hard" })
              yield* Deferred.succeed(spoke, true)
              yield* Effect.never
            }) as ReturnType<AgentTurnDriverShape["run"]>,
          stop: () => Effect.void
        })
      )
      const base = Layer.mergeAll(
        AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
        ConfigService.Default,
        SessionStore.Default,
        TranscriptStore.Default,
        BackgroundTaskStore.Default,
          ContextManager.Default,
        chattyAdapter,
        temp.layer
      )
      return yield* Effect.gen(function* () {
        const runner = yield* AgentRunner
        const seen: Array<StreamEvent> = []
        yield* Effect.fork(
          runner.prompt(SESSION, SESSION, "hello?").pipe(Stream.runForEach((e) => Effect.sync(() => seen.push(e))))
        )
        yield* Deferred.await(spoke)
        yield* TestClock.adjust("121 seconds")
        return seen
      }).pipe(Effect.provide(base))
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise)

    // One event is enough to prove the harness is alive. Killing a slow turn
    // that is genuinely working would be far worse than the bug being fixed.
    expect(events.some((e) => e._tag === "Failed")).toBe(false)
  })
})

describe("AgentRunner live tool output", () => {
  /** A harness that streams a running command's stdout, then settles with no output of its own. */
  const deltaAdapter = Layer.succeed(AgentTurnDriver, {
    run: (_sessionId, _spec, { emit }) =>
      Effect.gen(function* () {
        yield* emit({ _tag: "Started", sessionId: "harness-1" })
        yield* emit({ _tag: "ToolStart", id: "bash-1", name: "Bash", target: "pnpm test" })
        yield* emit({ _tag: "ToolDelta", id: "bash-1", output: "RUN v2\n" })
        yield* emit({ _tag: "ToolDelta", id: "bash-1", output: "RUN v2\n ✓ 3 passed\n" })
        // Settle WITHOUT re-stating the output — so the only way the tool could
        // carry text in the transcript is if a delta had been persisted.
        yield* emit({ _tag: "ToolEnd", id: "bash-1", status: "success", meta: null, diff: null, preview: null })
        yield* emit({ _tag: "Done", costUsd: 0, tokens: 0 })
      }),
    stop: () => Effect.void
  })

  it("streams ToolDelta to the consumer but never persists it to the transcript", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      deltaAdapter,
      ContextManager.Default,
      ConfigService.Default,
      temp.layer
    )
    const { events, transcript } = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* AgentRunner
        yield* runner.setMode(SESSION, "auto")
        const collected: Array<StreamEvent> = []
        yield* runner
          .prompt(SESSION, SESSION, "run the tests")
          .pipe(Stream.runForEach((ev) => Effect.sync(() => collected.push(ev))))
        return { events: collected, transcript: yield* TranscriptStore.list(SESSION) }
      }).pipe(Effect.provide(base))
    )

    // The live snapshots reach the consumer — that's what the renderer folds into
    // the running card so a widget can light up mid-run.
    expect(events.filter((e) => e._tag === "ToolDelta")).toHaveLength(2)

    // But the persisted card carries NO output, because ToolEnd stated none and
    // the deltas were stream-only. If a delta had been folded into transcript.json,
    // this would be the delta's text instead of undefined — the assertion that pins
    // the "never persist a per-tick full-file rewrite" contract.
    const toolPart = transcript
      .flatMap((m) => m.parts)
      .find((p) => p._tag === "Tool" && p.tool.id === "bash-1")
    expect(toolPart && toolPart._tag === "Tool" && toolPart.tool.status).toBe("success")
    expect(toolPart && toolPart._tag === "Tool" && toolPart.tool.output).toBeUndefined()
  })
})


describe("AgentRunner usage accrual", () => {
  /**
   * `Session.costUsd` and `tokens` were written as 0 at creation and never
   * updated, so the sidebar reported nothing however much work a session did.
   */
  it("adds each finished turn's usage to the session's running total", async () => {
    const base = Layer.mergeAll(
      AgentRunner.Default,
    BrowserControlMcpServiceTest,
    InMemorySecretStoreLive,
      ConfigService.Default,
      ContextManager.Default,
      SessionStore.Default,
      TranscriptStore.Default,
      BackgroundTaskStore.Default,
      makeScriptedAgentTurnDriver(0),
      temp.layer
    )
    const totals = await Effect.gen(function* () {
      mkdirSync(temp.root, { recursive: true })
      writeFileSync(
        join(temp.root, "sessions.json"),
        JSON.stringify([
          {
            id: SESSION,
            repo: "widget",
            branch: "b",
            title: "t",
            status: "idle",
            ...TEST_RUNTIME,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-19T00:00:00.000Z",
            worktreePath: temp.root,
            chats: [chatForSession("2026-07-19T00:00:00.000Z")],
            activeChatId: SESSION
          }
        ])
      )
      const runner = yield* AgentRunner
      // Two turns: the totals must ACCUMULATE. A session is many turns, and the
      // last turn's usage is not the session's usage.
      // The scripted harness gates its edit and its command; nothing else here
      // answers them, so the run would park forever.
      const turn = (text: string) =>
        runner.prompt(SESSION, SESSION, text).pipe(
          Stream.tap((ev) =>
            ev._tag === "GateRequested"
              ? runner.decideGate(SESSION, ev.gate.id, "allow")
              : Effect.void
          ),
          Stream.runDrain
        )
      yield* turn("one")
      const afterOne = yield* SessionStore.get(SESSION)
      yield* turn("two")
      const afterTwo = yield* SessionStore.get(SESSION)
      return { afterOne, afterTwo }
    }).pipe(Effect.provide(base), Effect.runPromise)

    // The scripted harness reports a fixed 0.38 / 42_100 per turn.
    expect(totals.afterOne.costUsd).toBeCloseTo(0.38, 5)
    expect(totals.afterOne.tokens).toBe(42_100)
    expect(totals.afterTwo.costUsd).toBeCloseTo(0.76, 5)
    expect(totals.afterTwo.tokens).toBe(84_200)
  })
})

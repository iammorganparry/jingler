import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppPaths,
  CliAdapter,
  ConfigService,
  DiscoveryService,
  GhService,
  GitService,
  ModelsService,
  OrchestrationService,
  PlanStore,
  ReviewService,
  ReviewStore,
  SessionStore,
  TranscriptStore,
  SkillsService,
  TerminalService,
  WorkspaceService
} from "@jingler/cli-adapters"
import type { AgentContext, CliAdapterShape, SessionSpec } from "@jingler/cli-adapters"
import type {
  Attachment,
  PlanDocument,
  PlanParticipant,
  Session,
  StreamEvent,
  WorkerActivity
} from "@jingler/core"
import { GitError } from "@jingler/core"
import { appPathsFor, fakeCommandExecutor } from "@jingler/cli-adapters/test-support"
import { NodeContext } from "@effect/platform-node"
import type { CommandExecutor } from "@effect/platform"
import { Chunk, Effect, Either, Fiber, Layer, Logger, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DialogService } from "./dialog.js"
import {
  chooseReposDir,
  configGet,
  createTerminal,
  githubDetectPr,
  githubSubmitReview,
  githubPr,
  modelsCatalog,
  modelsList,
  mergeCanonicalOrchestrationCheckpoints,
  newSessionOrchestrator,
  orchestrationStagesCompleted,
  planAppendMessage,
  planDispatchExistingMessageWithRouting,
  planDispatchMessageWithRouting,
  planSetThreadResolved,
  planUpdateMessageDelivery,
  planUsesOrchestration,
  planWatch,
  reviewGet,
  reviewMarkRouted,
  reviewReconcile,
  reviewRun,
  restoredOrchestrationSnapshot,
  setReasoning,
  setSessionPersistent,
  sessionCreationDefaults,
  sessionDiff,
  skillsList,
  watchOrchestrationWorkers,
  workspaceRevertFile,
  withoutAttachmentData,
  workspaceRevertLines
} from "./rpc.js"

/**
 * The RPC handlers own the app's error-folding policy: a config read error must
 * look like "not configured" (→ first-run setup), and a cancelled folder picker
 * must be a no-op. We run the real ConfigService against a temp root and fake
 * only the native dialog, asserting the outcomes the renderer depends on.
 */
describe("RPC handlers", () => {
  let dir: string
  let root: string
  let base: Layer.Layer<ConfigService | AppPaths | NodeContext.NodeContext>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jingler-rpc-"))
    root = join(dir, "jingler")
    base = Layer.mergeAll(
      ConfigService.Default,
      Layer.succeed(AppPaths, appPathsFor(root)),
      NodeContext.layer
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fakeDialog = (chosen: string | null) =>
    Layer.succeed(DialogService, { chooseDirectory: () => Effect.succeed(chosen) })

  it("keeps a new session direct when no planning route exists", () => {
    expect(sessionCreationDefaults("codex", null, null)).toMatchObject({
      cli: "codex",
      options: {
        chatRole: "direct",
        defaultMode: undefined,
        defaultModel: undefined
      }
    })
  })

  it("Sessions.setPersistent returns and persists the updated session", async () => {
    const now = "2026-07-30T10:00:00.000Z"
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, "sessions.json"),
      JSON.stringify([
        {
          id: "s1",
          repo: "widget",
          branch: "jingler/widget",
          title: "Widget",
          status: "idle",
          cli: "claude",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          chats: [
            {
              id: "c1",
              title: null,
              createdAt: now,
              updatedAt: now
            }
          ],
          activeChatId: "c1"
        }
      ])
    )
    const layer = Layer.mergeAll(base, SessionStore.Default)

    const updated = await Effect.runPromise(
      setSessionPersistent("s1", true).pipe(Effect.provide(layer))
    )
    const reloaded = await Effect.runPromise(
      SessionStore.get("s1").pipe(Effect.provide(layer))
    )

    expect(updated.persistent).toBe(true)
    expect(reloaded.persistent).toBe(true)
  })

  it("falls back to direct session creation when model discovery crashes", async () => {
    const brokenDiscovery = Layer.succeed(
      DiscoveryService,
      new DiscoveryService({ list: () => Effect.die("catalogue unavailable") })
    )
    const unusedModels = Layer.succeed(
      ModelsService,
      new ModelsService({
        list: () => Effect.succeed([]),
        catalog: () => Effect.succeed([])
      })
    )

    const resolution = await Effect.runPromise(
      newSessionOrchestrator(null).pipe(
        Effect.provide(
          Layer.mergeAll(
            brokenDiscovery,
            unusedModels,
            fakeCommandExecutor(() => ({ exitCode: 0, stdout: "" }))
          )
        )
      )
    )

    expect(resolution).toBeNull()
    expect(sessionCreationDefaults("codex", null, resolution).options.chatRole)
      .toBe("direct")
  })

  it("derives plan execution strategy from the producing chat, not the active chat", () => {
    const session = {
      activeChatId: "direct-chat",
      chats: [
        { id: "direct-chat", role: "direct" },
        { id: "planner-chat", role: "orchestrator" }
      ]
    } as unknown as Session
    const document = {
      producingChatId: "planner-chat"
    } as unknown as PlanDocument

    expect(planUsesOrchestration(session, document)).toBe(true)
    expect(
      planUsesOrchestration(
        { ...session, activeChatId: "planner-chat" },
        { ...document, producingChatId: "direct-chat" }
      )
    ).toBe(false)
  })

  it("routes revision-guarded thread mutations through the session plan worktree", async () => {
    const now = "2026-07-31T09:00:00.000Z"
    const worktreePath = join(dir, "worktree")
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, "sessions.json"),
      JSON.stringify([
        {
          id: "session-plan-thread",
          repo: "widget",
          branch: "jingler/widget",
          title: "Widget",
          status: "idle",
          cli: "codex",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          worktreePath,
          chats: [
            {
              id: "chat-plan-thread",
              title: null,
              createdAt: now,
              updatedAt: now
            }
          ],
          activeChatId: "chat-plan-thread"
        }
      ])
    )
    const services = Layer.mergeAll(
      SessionStore.Default,
      PlanStore.Default
    ).pipe(Layer.provideMerge(base))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* PlanStore.promoteDocument(worktreePath, {
          sessionId: "session-plan-thread",
          producingChatId: "chat-plan-thread",
          id: "plan-thread",
          source: `<h1>PRD: Thread RPC</h1>
<section data-stage="01" data-title="Persist">
<div data-acceptance="01.1" data-status="pending">It persists.</div>
</section>`,
          author: "agent"
        })
        const withThread = yield* PlanStore.addAnnotation(worktreePath, {
          planId: plan.id,
          baseRevision: plan.revision,
          stageId: "01",
          body: "Can you verify this?",
          author: "user"
        })
        const annotationId = withThread.projection.annotations[0]!.id
        const watchedFiber = yield* planWatch("session-plan-thread").pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.fork
        )
        yield* Effect.sleep("25 millis")
        const appended = yield* planAppendMessage({
          sessionId: "session-plan-thread",
          planId: plan.id,
          baseRevision: withThread.revision,
          annotationId,
          body: "Verified.",
          authorKind: "agent",
          authorId: "worker-storage",
          mentionedParticipantIds: ["operator"],
          deliveryState: "pending"
        })
        const watched = Chunk.toReadonlyArray(yield* Fiber.join(watchedFiber))[0]
        const messageId = appended.projection.annotations[0]!.messages[1]!.id
        const delivered = yield* planUpdateMessageDelivery({
          sessionId: "session-plan-thread",
          planId: plan.id,
          baseRevision: appended.revision,
          annotationId,
          messageId,
          deliveryState: "sent",
          author: "agent"
        })
        const resolved = yield* planSetThreadResolved({
          sessionId: "session-plan-thread",
          planId: plan.id,
          baseRevision: delivered.revision,
          annotationId,
          resolved: true,
          author: "user"
        })
        const stale = yield* Effect.either(
          planSetThreadResolved({
            sessionId: "session-plan-thread",
            planId: plan.id,
            baseRevision: appended.revision,
            annotationId,
            resolved: false,
            author: "user"
          })
        )
        return { appended, delivered, resolved, stale, watched }
      }).pipe(Effect.provide(services))
    )

    expect(result.appended.projection.annotations[0]?.messages[1]).toMatchObject({
      body: "Verified.",
      authorKind: "agent",
      authorId: "worker-storage",
      mentionedParticipantIds: ["operator"],
      deliveryState: "pending"
    })
    expect(result.delivered.projection.annotations[0]?.messages[1]?.deliveryState).toBe("sent")
    expect(result.resolved.projection.annotations[0]?.status).toBe("resolved")
    expect(result.watched?.revision).toBe(result.appended.revision)
    expect(result.watched?.projection.annotations[0]?.messages[1]?.body).toBe(
      "Verified."
    )
    expect(Either.isLeft(result.stale)).toBe(true)
    if (Either.isLeft(result.stale)) {
      expect(result.stale.left).toMatchObject({
        _tag: "PlanConflictError",
        latestRevision: result.resolved.revision
      })
    }
  })

  it("persists mention delivery, same-thread replies, relays, and stale-target notices", async () => {
    const now = "2026-07-31T09:30:00.000Z"
    const worktreePath = join(dir, "mention-worktree")
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, "sessions.json"),
      JSON.stringify([
        {
          id: "session-mentions",
          repo: "widget",
          branch: "jingler/widget",
          title: "Widget",
          status: "idle",
          cli: "codex",
          diff: { added: 0, removed: 0 },
          prNumber: null,
          costUsd: 0,
          tokens: 0,
          updatedAt: now,
          worktreePath,
          chats: [
            {
              id: "chat-mentions",
              title: null,
              createdAt: now,
              updatedAt: now
            }
          ],
          activeChatId: "chat-mentions"
        }
      ])
    )
    const orchestrator = {
      routingId: "orchestrator:chat-mentions",
      displayName: "Orchestrator",
      role: "orchestrator",
      lifecycle: "parked",
      ownerRoutingId: null
    } as const
    const worker = {
      routingId: "worker:plan-mentions:worker-core:1",
      displayName: "worker-core",
      role: "worker",
      lifecycle: "running",
      ownerRoutingId: null
    } as const
    const prompts: Array<string> = []
    const routing = {
      participants: () => Effect.succeed([orchestrator, worker]),
      route: (
        target: PlanParticipant,
        request: {
          readonly sessionId: string
          readonly planId: string
          readonly text: string
        }
      ) =>
        Effect.sync(() => {
          prompts.push(request.text)
          return target.role === "orchestrator"
            ? {
                status: "delivered" as const,
                reply:
                  `I will ask the implementation worker. ` +
                  `[[mention:${worker.routingId}]]`
              }
            : {
                status: "delivered" as const,
                reply: "The worker verified the parser."
              }
        })
    }
    const services = Layer.mergeAll(
      SessionStore.Default,
      PlanStore.Default
    ).pipe(Layer.provideMerge(base))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* PlanStore.promoteDocument(worktreePath, {
          sessionId: "session-mentions",
          producingChatId: "chat-mentions",
          id: "plan-mentions",
          source: `<h1>PRD: Mentions</h1>
<section data-stage="01" data-title="Route">
<div data-acceptance="01.1" data-status="pending">It routes.</div>
</section>`,
          author: "agent"
        })
        const withThread = yield* PlanStore.addAnnotation(worktreePath, {
          planId: plan.id,
          baseRevision: plan.revision,
          stageId: "01",
          body: "Initial note.",
          author: "user"
        })
        const annotationId = withThread.projection.annotations[0]!.id
        const routed = yield* planDispatchMessageWithRouting(
          {
            sessionId: "session-mentions",
            planId: plan.id,
            baseRevision: withThread.revision,
            annotationId,
            body: "Please coordinate this check.",
            authorId: "operator",
            mentionedParticipantIds: [orchestrator.routingId]
          },
          routing
        )
        const unavailable = yield* planDispatchMessageWithRouting(
          {
            sessionId: "session-mentions",
            planId: plan.id,
            baseRevision: routed.document.revision,
            annotationId,
            body: "Try the old worker.",
            authorId: "operator",
            mentionedParticipantIds: ["worker:plan-mentions:worker-core:0"]
          },
          {
            participants: () => Effect.succeed([]),
            route: () =>
              Effect.succeed({
                status: "failed" as const,
                detail: "This route must not be called."
              })
          }
        )
        const pendingThread = yield* PlanStore.addAnnotation(worktreePath, {
          planId: plan.id,
          baseRevision: unavailable.document.revision,
          stageId: "01",
          body: "Route this selection comment once.",
          author: "user",
          authorId: "operator",
          mentionedParticipantIds: [orchestrator.routingId],
          deliveryState: "pending"
        })
        const pendingAnnotation = pendingThread.projection.annotations.at(-1)!
        const existing = yield* planDispatchExistingMessageWithRouting(
          {
            sessionId: "session-mentions",
            planId: plan.id,
            baseRevision: pendingThread.revision,
            annotationId: pendingAnnotation.id,
            messageId: pendingAnnotation.messages[0]!.id
          },
          routing
        )
        return { routed, unavailable, existing }
      }).pipe(Effect.provide(services))
    )

    const routedMessages =
      result.routed.document.projection.annotations[0]!.messages
    expect(routedMessages.slice(1)).toMatchObject([
      {
        body: "Please coordinate this check.",
        authorKind: "user",
        deliveryState: "sent"
      },
      {
        body: "I will ask the implementation worker.",
        authorId: orchestrator.routingId,
        mentionedParticipantIds: [worker.routingId],
        deliveryState: "sent"
      },
      {
        body: "The worker verified the parser.",
        authorId: worker.routingId,
        deliveryState: "sent"
      }
    ])
    expect(result.routed.deliveries.map((delivery) => delivery.status)).toEqual([
      "delivered",
      "delivered"
    ])
    expect(prompts).toHaveLength(4)

    const unavailableMessages =
      result.unavailable.document.projection.annotations[0]!.messages
    expect(unavailableMessages.at(-2)).toMatchObject({
      body: "Try the old worker.",
      deliveryState: "failed"
    })
    expect(unavailableMessages.at(-1)).toMatchObject({
      authorId: "jingler:dispatcher",
      body: expect.stringContaining("became unavailable")
    })
    expect(result.unavailable.deliveries[0]).toMatchObject({
      status: "unavailable",
      retryable: true
    })
    const existingMessages =
      result.existing.document.projection.annotations.at(-1)!.messages
    expect(existingMessages.map((message) => message.body)).toEqual([
      "Route this selection comment once.",
      "I will ask the implementation worker.",
      "The worker verified the parser."
    ])
    expect(existingMessages[0]?.deliveryState).toBe("sent")
  })

  it("restores canonical completion across a checkpoint crash window", () => {
    const assignment = {
      agentId: "worker-a",
      cli: "codex" as const,
      model: "gpt-5",
      reason: "Test."
    }
    const document = {
      projection: {
        stages: [
          {
            id: "01",
            assignment,
            executionStatus: "completed"
          },
          {
            id: "02",
            assignment,
            executionStatus: "queued"
          }
        ]
      }
    } as unknown as PlanDocument
    const restored = mergeCanonicalOrchestrationCheckpoints(document, [
      {
        agentId: "worker-a",
        state: "running",
        completedStageIds: ["01", "02"],
        resumeId: "resume-a",
        message: null,
        attempt: 1
      }
    ])

    expect(restored[0]?.completedStageIds).toEqual(["01"])
    expect(orchestrationStagesCompleted(document)).toBe(false)
    expect(
      orchestrationStagesCompleted({
        ...document,
        projection: {
          ...document.projection,
          stages: document.projection.stages.map((stage) => ({
            ...stage,
            executionStatus: "completed" as const
          }))
        }
      })
    ).toBe(true)
  })

  it("restores worker tabs from durable checkpoints after a main-process restart", () => {
    const document: PlanDocument = {
      id: "plan-1",
      sessionId: "session-1",
      producingChatId: "chat-1",
      revision: 2,
      status: "needs-verification",
      source: "<h1>Plan</h1>",
      updatedAt: "2026-07-30T12:00:00.000Z",
      updatedBy: "agent",
      projection: {
        title: "Plan",
        sections: [],
        annotations: [],
        stages: [
          {
            id: "01",
            title: "Auth",
            intent: "Implement auth",
                    markdown: "<p>Auth</p><ul data-files><li>src/auth.ts</li></ul>",
            acceptance: [],
            dependencies: [],
            complexity: "medium",
            assignment: {
              agentId: "worker-auth",
              cli: "claude",
              model: "opus",
              reason: "Test route"
            },
            executionStatus: "running"
          },
          {
            id: "02",
            title: "Release",
            intent: "Implement release",
                    markdown: "<p>Release</p><ul data-files><li>src/release.ts</li></ul>",
            acceptance: [],
            dependencies: [],
            complexity: "medium",
            assignment: {
              agentId: "worker-release",
              cli: "codex",
              model: "gpt-5.6-sol",
              reason: "Test route"
            },
            executionStatus: "completed"
          }
        ]
      }
    }
    const restored = restoredOrchestrationSnapshot(
      "session-1",
      document,
      [
        {
          agentId: "worker-auth",
          state: "running",
          completedStageIds: [],
          resumeId: "resume-auth",
          message: null,
          attempt: 1
        },
        {
          agentId: "worker-release",
          state: "completed",
          completedStageIds: ["02"],
          resumeId: "resume-release",
          message: null,
          attempt: 1
        }
      ]
    )

    expect(restored).toMatchObject({
      _tag: "Reset",
      mode: "replace",
      workers: [
        {
          worker: { agentId: "worker-auth", harness: "claude" },
          status: "interrupted"
        },
        {
          worker: { agentId: "worker-release", harness: "codex" },
          status: "completed"
        }
      ]
    })
  })

  it("watches the requested worker scope without starting execution", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const activity: WorkerActivity = {
      _tag: "Reset",
      sessionId: "session-1",
      planId: "plan-1",
      producingChatId: "chat-1",
      mode: "replace",
      workers: []
    }
    const service = OrchestrationService.make({
      execute: () => Effect.die("watch must not execute workers"),
      stopWorker: () => Effect.void,
      stopSession: () => Effect.void,
      isPlanRunning: () => Effect.succeed(false),
      planParticipants: () => Effect.succeed([]),
      steerPlanParticipant: () =>
        Effect.succeed({
          status: "unavailable",
          detail: "No live participant."
        }),
      activityFeedCount: () => Effect.succeed(0),
      watch: (sessionId, planId, chatId) => {
        calls.push([sessionId, planId, chatId])
        return Stream.make(activity)
      }
    })

    const received = await Effect.runPromise(
      watchOrchestrationWorkers("session-1", "plan-1", "chat-1").pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            SessionStore.Default,
            PlanStore.Default,
            Layer.succeed(OrchestrationService, service)
          ).pipe(Layer.provideMerge(base))
        )
      )
    )

    expect(calls).toEqual([["session-1", "plan-1", "chat-1"]])
    expect([...received]).toEqual([activity])
  })

  describe("Agent.setReasoning", () => {
    it("logs a best-effort persistence failure", async () => {
      const messages: Array<{ level: string; text: string }> = []
      const logger = Logger.make(({ logLevel, message }) => {
        const text = Array.isArray(message) ? message.map(String).join(" ") : String(message)
        messages.push({ level: logLevel.label, text })
      })
      const store = await Effect.runPromise(
        SessionStore.pipe(Effect.provide(SessionStore.Default))
      )
      const failedStore = SessionStore.make({
        ...store,
        setReasoning: () =>
          Effect.fail(new GitError({ message: "test sessions.json write failed" }))
      })

      await Effect.runPromise(
        setReasoning("session-1", "claude", { enabled: true, effort: "high" }).pipe(
          Effect.provide(Layer.succeed(SessionStore, failedStore)),
          Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
          Effect.provide(base)
        )
      )

      expect(messages).toContainEqual({
        level: "WARN",
        text: "Failed to persist reasoning strength for session session-1: test sessions.json write failed"
      })
    })
  })

  /**
   * No harness discovered — which keeps this hermetic. The real DiscoveryService
   * would find the operator's actual `claude` binary, and listing skills asks the
   * harness what it offers, so the test would spawn a CLI.
   */
  const noHarnesses = Layer.succeed(
    DiscoveryService,
    new DiscoveryService({ list: () => Effect.succeed([]) })
  )

  /**
   * `visibleModels` narrows the COMPOSER's menu. Letting it narrow Settings'
   * default-model picker too would make it a one-way door: curate down to a few
   * models and the rest can never be chosen as your default again, from the very
   * screen you'd use to un-curate. Configuration surfaces show what exists.
   *
   * It matters more than it looks: no UI writes `visibleModels` yet, so today the
   * only writer is a hand-edited `config.json` — which is exactly the user who
   * would get stuck.
   */
  describe("Models.list / Models.catalog — curation", () => {
    const CLAUDE_MODELS = [
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
      { id: "haiku", label: "haiku" }
    ]
    const models = Layer.succeed(
      ModelsService,
      new ModelsService({
        list: () => Effect.succeed(CLAUDE_MODELS),
        catalog: () =>
          Effect.succeed([{ cli: "claude" as const, label: "Claude Code", models: CLAUDE_MODELS }])
      })
    )
    const env = () => Layer.mergeAll(base, noHarnesses, models)

    /** Curate this session's harness down to a single model. */
    const curate = ConfigService.setProvider("claude", {
      enabled: true,
      defaultMode: "accept-edits",
      visibleModels: ["opus"]
    })

    it("honours curation in the composer's menu — the surface it's for", async () => {
      const catalog = await Effect.runPromise(
        Effect.gen(function* () {
          yield* curate
          return yield* modelsCatalog()
        }).pipe(Effect.provide(env()))
      )
      expect(catalog[0]?.models.map((m) => m.id)).toStrictEqual(["opus"])
    })

    it("NEVER narrows the Settings picker, so curation stays reversible", async () => {
      const list = await Effect.runPromise(
        Effect.gen(function* () {
          yield* curate
          return yield* modelsList("claude")
        }).pipe(Effect.provide(env()))
      )
      expect(list.map((m) => m.id)).toStrictEqual(["opus", "sonnet", "haiku"])
    })
  })

  describe("Skills.list", () => {
    // An unknown session must not error — the `/` menu just has nothing to add.
    it("resolves for an unknown session, rather than failing", async () => {
      const skills = await Effect.runPromise(
        skillsList("nope").pipe(
          Effect.provide(
            Layer.mergeAll(base, SessionStore.Default, SkillsService.Default, noHarnesses)
          )
        )
      )
      // No session → no worktree to scan, and no harness discovered → nothing to
      // ask. Whatever the operator's real ~/.claude/skills holds may still be
      // scanned, so we assert the CONTRACT rather than a count: it resolves, and
      // it never conjures a command the harness doesn't have. `/plan`, `/test`
      // and `/commit` used to be served from a hardcoded list; none are real.
      expect(Array.isArray(skills)).toBe(true)
      expect(skills.map((s) => s.name)).not.toContain("/plan")
      expect(skills.map((s) => s.name)).not.toContain("/test")
      expect(skills.map((s) => s.name)).not.toContain("/commit")
    })
  })

  describe("Sessions.transcriptPage — attachment stripping", () => {
    /**
     * A transcript's images are 80% of its bytes (98MB of 123MB, measured across
     * the six largest on a real install) and its text is 1.5%. Handing those to
     * the renderer on open is what made a session cost hundreds of megabytes
     * there, so the RPC ships the metadata and the renderer fetches bytes per
     * thumbnail.
     */
    const image = (id: string, data: string) => ({
      _tag: "Image" as const,
      attachment: { id, name: `${id}.png`, mediaType: "image/png", data }
    })
    const message = (id: string, parts: ReadonlyArray<unknown>) =>
      ({ id, role: "user", streaming: false, createdAt: "2026-07-11T00:00:00.000Z", parts }) as never

    it("empties the base64 but keeps everything a thumbnail needs", () => {
      const [out] = withoutAttachmentData([message("u_1", [image("att_1", "AAAABBBB")])])
      const part = out!.parts[0] as ReturnType<typeof image>
      expect(part.attachment.data).toBe("")
      // The tile renders its frame, filename and alt text before the bytes land,
      // and the id is how it asks for them — losing any of these turns a lazy
      // image into a missing one.
      expect(part.attachment.id).toBe("att_1")
      expect(part.attachment.name).toBe("att_1.png")
      expect(part.attachment.mediaType).toBe("image/png")
    })

    it("returns an image-free message BY REFERENCE", () => {
      // Not a micro-optimisation: this walks transcripts that reach 46MB, on
      // every session open, and the renderer's footprint is a high-water mark of
      // exactly these loads. Copying a message to change nothing in it is the
      // cost the whole function exists to avoid, and `toStrictEqual` would pass
      // against a version that copied every one.
      const plain = message("u_2", [{ _tag: "Text", text: "no pictures here" }])
      const [out] = withoutAttachmentData([plain])
      expect(out).toBe(plain)
    })

    it("leaves non-image parts of a message that HAS an image alone", () => {
      const text = { _tag: "Text" as const, text: "what is wrong here" }
      const [out] = withoutAttachmentData([message("u_3", [image("att_2", "CCCC"), text])])
      expect(out!.parts[1]).toBe(text)
    })
  })

  describe("Sessions.diff", () => {
    // An unknown session (or one without a worktree) yields no diff, not an error.
    it("returns an empty diff for an unknown session", async () => {
      const patch = await Effect.runPromise(
        sessionDiff("nope").pipe(
          Effect.provide(Layer.mergeAll(base, SessionStore.Default, WorkspaceService.Default))
        )
      )
      expect(patch).toBe("")
    })
  })

  describe("Workspace.revert*", () => {
    // Revert on an unknown / worktree-less session must be a safe no-op.
    it("no-ops for an unknown session (no worktree to touch)", async () => {
      const ws = Layer.mergeAll(base, SessionStore.Default, WorkspaceService.Default)
      await expect(
        Effect.runPromise(workspaceRevertFile({ sessionId: "nope", path: "a.ts" }).pipe(Effect.provide(ws)))
      ).resolves.toBeUndefined()
      await expect(
        Effect.runPromise(
          workspaceRevertLines({ sessionId: "nope", path: "a.ts", startLine: 1, endLine: 2 }).pipe(
            Effect.provide(ws)
          )
        )
      ).resolves.toBeUndefined()
    })

    it("refuses destructive revert actions for a direct session", async () => {
      const now = "2026-07-30T10:00:00.000Z"
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "direct-session",
            repo: "widget",
            branch: "main",
            baseBranch: "main",
            title: "Production checkout",
            status: "idle",
            cli: "claude",
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath: dir,
            repoPath: dir,
            workspaceMode: "direct",
            chats: [
              {
                id: "direct-chat",
                title: null,
                createdAt: now,
                updatedAt: now
              }
            ],
            activeChatId: "direct-chat"
          }
        ])
      )
      const ws = Layer.mergeAll(
        base,
        SessionStore.Default,
        WorkspaceService.Default
      )

      await expect(
        Effect.runPromise(
          workspaceRevertFile({
            sessionId: "direct-session",
            path: "developer-edit.ts"
          }).pipe(Effect.provide(ws))
        )
      ).rejects.toThrow(/disabled for direct sessions/i)
      await expect(
        Effect.runPromise(
          workspaceRevertLines({
            sessionId: "direct-session",
            path: "developer-edit.ts",
            startLine: 1,
            endLine: 2
          }).pipe(Effect.provide(ws))
        )
      ).rejects.toThrow(/disabled for direct sessions/i)
    })
  })

  describe("Terminal.create", () => {
    // The renderer stays oblivious to worktree paths: the handler resolves cwd
    // (explicit cwd wins; otherwise the session's worktree; otherwise the
    // process cwd). Uses a real PTY, always reclaimed via killAll.
    const runCreate = (input: { sessionId: string; cwd?: string; cols: number; rows: number }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const info = yield* createTerminal(input)
          yield* Effect.flatMap(TerminalService, (t) => t.killAll) // reclaim the PTY
          return info
        }).pipe(Effect.provide(Layer.mergeAll(base, SessionStore.Default, TerminalService.Default)))
      )

    it("spawns in an explicit cwd when one is given", async () => {
      const info = await runCreate({ sessionId: "s1", cwd: dir, cols: 80, rows: 24 })
      expect(info.cwd).toBe(dir)
      expect(info.status).toBe("running")
      expect(info.sessionId).toBe("s1")
    })

    it("anchors a session-less terminal to home, NOT the app's own directory", async () => {
      // This test used to assert the opposite — that the terminal fell back to
      // `process.cwd()`. That was the bug written down as a guarantee: the app's
      // cwd is, in development, whichever worktree `pnpm dev` was launched from,
      // so a terminal with no worktree opened *inside an unrelated repo* and
      // anything typed there ran against that repo's files.
      const info = await runCreate({ sessionId: "nope", cols: 80, rows: 24 })
      expect(info.cwd).toBe(homedir())
      expect(info.cwd).not.toBe(process.cwd())
    })
  })

  describe("Github.pr / Github.detectPr", () => {
    // A PR-less / unknown session must be a no-op (null), never an error, so the
    // renderer shows the empty "Create pull request" state.
    it("returns null for an unknown session without spawning gh", async () => {
      const gh = Layer.mergeAll(base, SessionStore.Default, GhService.Default)
      const pr = await Effect.runPromise(githubPr("nope").pipe(Effect.provide(gh)))
      expect(pr).toBeNull()
      const detected = await Effect.runPromise(githubDetectPr("nope").pipe(Effect.provide(gh)))
      expect(detected).toBeNull()
    })
  })

  describe("Github.submitReview", () => {
    // Unlike the reads above, submitting is a user-initiated write: silently
    // succeeding on a session with no PR would swallow the reviewer's drafts
    // with no sign they went nowhere.
    it("fails rather than silently dropping drafts when no PR is linked", async () => {
      const gh = Layer.mergeAll(base, SessionStore.Default, GhService.Default)
      const exit = await Effect.runPromiseExit(
        githubSubmitReview({
          sessionId: "nope",
          comments: [{ path: "a.ts", line: 2, startLine: null, body: "c" }]
        }).pipe(Effect.provide(gh))
      )
      expect(exit._tag).toBe("Failure")
    })

    /**
     * The whole point of the handler: a draft written on a line becomes an
     * INLINE comment on that line, anchored to the PR's current head. Asserting
     * the JSON that actually reaches `gh` is the only way to know that — every
     * layer above it can look correct while posting a flattened blob.
     */
    it("posts anchorable drafts inline and folds the rest into the body", async () => {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "s1",
            repo: "widget",
            branch: "feature",
            title: "Feature",
            status: "idle",
            cli: "claude",
            diff: { added: 0, removed: 0 },
            prNumber: 42,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-16T10:00:00.000Z",
            worktreePath: join(root, "worktrees", "s1"),
            baseBranch: "main"
          }
        ])
      )

      let posted: { commit_id: string; body: string; comments: ReadonlyArray<Record<string, unknown>> } | null = null
      const gh = Layer.mergeAll(
        base,
        SessionStore.Default,
        GhService.Default,
        fakeCommandExecutor((cmd, args, stdin) => {
          if (cmd !== "gh") return { stdout: "" }
          if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: "headsha" }) }
          // a.ts gains new-side lines 1-2; nothing else is in the diff.
          if (args[1] === "diff") {
            return {
              stdout: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " const x = 1", "+const y = 2"].join("\n")
            }
          }
          if (args[0] === "api") {
            posted = JSON.parse(stdin)
            return { exitCode: 0, stdout: "{}" }
          }
          return { stdout: "" }
        })
      )

      const unanchored = await Effect.runPromise(
        githubSubmitReview({
          sessionId: "s1",
          comments: [
            { path: "a.ts", line: 2, startLine: null, body: "on the diff" },
            { path: "a.ts", line: 99, startLine: null, body: "moved off the diff" }
          ]
        }).pipe(Effect.provide(gh))
      )

      expect(unanchored).toBe(1)
      expect(posted).not.toBeNull()
      expect(posted!.commit_id).toBe("headsha")
      expect(posted!.comments).toStrictEqual([
        { path: "a.ts", line: 2, side: "RIGHT", body: "on the diff" }
      ])
      // The stale one keeps its words instead of 422-ing the whole review.
      expect(posted!.body).toContain("moved off the diff")
      expect(posted!.body).toContain("a.ts:99")
    })
  })

  /**
   * The head-SHA short-circuit is what makes the auto-review trigger safe to
   * fire off a poll loop: an unchanged PR must cost a cheap `gh pr view`, never
   * an agent run. These tests count reviewer spawns to assert that as a fact
   * rather than an intention.
   */
  describe("Review.run", () => {
    /** Persist a session with a linked PR by writing the store's own file. */
    const withSession = (over: Record<string, unknown> = {}) => {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "sessions.json"),
        JSON.stringify([
          {
            id: "s1",
            repo: "widget",
            branch: "feature",
            title: "Feature",
            status: "idle",
            cli: "claude",
            diff: { added: 0, removed: 0 },
            prNumber: 42,
            costUsd: 0,
            tokens: 0,
            updatedAt: "2026-07-16T10:00:00.000Z",
            worktreePath: join(root, "worktrees", "s1"),
            baseBranch: "main",
            ...over
          }
        ])
      )
    }

    /**
     * `gh` reporting a fixed head SHA + a non-empty diff, on a host where the
     * `claude` binary resolves. The binary matters: with no binary the reviewer
     * would be dispatched to the scripted stub, and ReviewService rejects that
     * rather than pass stub prose off as a review.
     */
    const fakeGh = (headSha: string) =>
      fakeCommandExecutor((cmd, args) => {
        if (cmd === "which" || cmd === "where") {
          return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
        }
        if (cmd !== "gh") return { stdout: "2.1.0" }
        if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: headSha }) }
        if (args[1] === "diff") return { stdout: "diff --git a/a.ts b/a.ts\n+x\n" }
        return { stdout: "" }
      })

    /** A reviewer stub that counts its runs and always reports one finding. */
    const countingAdapter = () => {
      const spawns: SessionSpec[] = []
      const layer = Layer.succeed(
        CliAdapter,
        CliAdapter.of({
          run: ((_id: string, spec: SessionSpec, ctx: AgentContext) =>
            Effect.gen(function* () {
              spawns.push(spec)
              yield* ctx.emit({
                _tag: "Assistant",
                text: '```json\n{"findings":[{"title":"A bug","severity":"major"}]}\n```'
              })
            })) as CliAdapterShape["run"],
          stop: () => Effect.void
        })
      )
      return { spawns, layer }
    }

    const envFor = (headSha: string, adapter: Layer.Layer<CliAdapter>) =>
      Layer.mergeAll(
        Layer.succeed(AppPaths, appPathsFor(root)),
        NodeContext.layer,
        fakeGh(headSha)
      ).pipe(
        (leaf) =>
          Layer.mergeAll(
            ConfigService.Default,
            SessionStore.Default,
            GhService.Default,
            ReviewStore.Default,
            ReviewService.Default,
            DiscoveryService.Default,
            adapter
          ).pipe(Layer.provideMerge(leaf))
      )

    it("fails with ReviewError when the session has no linked PR", async () => {
      withSession({ prNumber: null })
      const { layer } = countingAdapter()
      const exit = await Effect.runPromiseExit(
        reviewRun("s1", false).pipe(Effect.provide(envFor("abc", layer)))
      )
      expect(exit._tag).toBe("Failure")
    })

    it("fails with ReviewError for an unknown session", async () => {
      const { layer, spawns } = countingAdapter()
      const exit = await Effect.runPromiseExit(
        reviewRun("nope", false).pipe(Effect.provide(envFor("abc", layer)))
      )
      expect(exit._tag).toBe("Failure")
      expect(spawns).toHaveLength(0)
    })

    it("runs the reviewer and stores the review against the PR head", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      const review = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer)))
      )
      expect(spawns).toHaveLength(1)
      expect(review.headSha).toBe("sha-one")
      expect(review.findings).toHaveLength(1)
      // Fable is the default reviewer when nothing is configured.
      expect(review.model).toBe("claude-fable-5")
    })

    it("does not expose or stamp a stored review after the active PR changes", async () => {
      withSession({ prNumber: 42 })
      const { layer } = countingAdapter()
      const env = envFor("sha-one", layer)
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))

      withSession({ prNumber: 43 })
      const visible = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(env)))
      const stamp = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(env)))
      expect(visible).toBeNull()
      expect(stamp).toBeNull()
    })

    /**
     * Reconciliation credits the commits that fixed findings. What matters here
     * is the NULL contract: the renderer calls this after every settled turn, so
     * "nothing changed" must be distinguishable from "here is a review", or the
     * review pane re-renders on every turn for nothing.
     */
    describe("Review.reconcile", () => {
      /** `gh` as above, plus a `git log` whose output is the commits since the head. */
      const gitEnv = (headSha: string, log: string, adapter: Layer.Layer<CliAdapter>) =>
        Layer.mergeAll(
          Layer.succeed(AppPaths, appPathsFor(root)),
          NodeContext.layer,
          fakeCommandExecutor((cmd, args) => {
            if (cmd === "which" || cmd === "where") {
              return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
            }
            if (cmd === "git") return args[2] === "log" ? { stdout: log } : { stdout: "" }
            if (cmd !== "gh") return { stdout: "2.1.0" }
            if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: headSha }) }
            if (args[1] === "diff") return { stdout: "diff --git a/a.ts b/a.ts\n+x\n" }
            return { stdout: "" }
          })
        ).pipe(
          (leaf) =>
            Layer.mergeAll(
              ConfigService.Default,
              SessionStore.Default,
              GhService.Default,
              GitService.Default,
              ReviewStore.Default,
              ReviewService.Default,
              DiscoveryService.Default,
              adapter
            ).pipe(Layer.provideMerge(leaf))
        )

      /** `git log --reverse --name-only --pretty=format:%H\x1f%s` output. */
      const gitLog = (sha: string, subject: string, files: string[]) =>
        `${sha}\x1f${subject}\n${files.join("\n")}\n`

      it("returns null when there is no stored review", async () => {
        withSession()
        const { layer } = countingAdapter()
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(Effect.provide(gitEnv("sha-one", "", layer)))
        )
        expect(out).toBeNull()
      })

      it("credits the commit that touched the finding's file, and persists it", async () => {
        withSession()
        const { layer } = countingAdapter()
        // The stub reports one finding with no path, so anchor it by hand — the
        // attribution rule is path-based and a pathless finding never resolves.
        const seed = gitEnv("sha-one", "", layer)
        const stored = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(seed)))
        await Effect.runPromise(
          ReviewStore.set("s1", {
            ...stored,
            findings: [{ ...stored.findings[0]!, path: "src/auth.ts" }]
          }).pipe(Effect.provide(seed))
        )

        const env = gitEnv(
          "sha-one",
          gitLog("9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204", "fix(auth): timingSafeEqual", [
            "src/auth.ts"
          ]),
          layer
        )
        const out = await Effect.runPromise(reviewReconcile("s1").pipe(Effect.provide(env)))
        expect(out?.findings[0]?.resolvedBy).toMatchObject({
          sha: "9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204",
          subject: "fix(auth): timingSafeEqual"
        })
        // Persisted, not just returned — the next read must agree.
        const reread = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(env)))
        expect(reread?.findings[0]?.resolvedBy?.sha).toBe("9f2c1ab4e7d8905361bb2f0c4a7e13d5c8a6b204")
      })

      it("returns null when no commit touched a finding's file", async () => {
        withSession()
        const { layer } = countingAdapter()
        const seed = gitEnv("sha-one", "", layer)
        const stored = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(seed)))
        await Effect.runPromise(
          ReviewStore.set("s1", {
            ...stored,
            findings: [{ ...stored.findings[0]!, path: "src/auth.ts" }]
          }).pipe(Effect.provide(seed))
        )

        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(
            Effect.provide(gitEnv("sha-one", gitLog("aaa", "unrelated", ["src/other.ts"]), layer))
          )
        )
        expect(out).toBeNull()
      })

      it("returns null for a session with no worktree", async () => {
        withSession({ worktreePath: undefined })
        const { layer } = countingAdapter()
        const out = await Effect.runPromise(
          reviewReconcile("s1").pipe(Effect.provide(gitEnv("sha-one", "", layer)))
        )
        expect(out).toBeNull()
      })

      it("does not reconcile a stored review from a previous PR", async () => {
        withSession({ prNumber: 42 })
        const { layer } = countingAdapter()
        const env = gitEnv("sha-one", "", layer)
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))

        withSession({ prNumber: 43 })
        const out = await Effect.runPromise(reviewReconcile("s1").pipe(Effect.provide(env)))
        expect(out).toBeNull()
      })
    })

    it("re-running on an unchanged head returns the stored review WITHOUT spawning a reviewer", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      const env = envFor("sha-one", layer)
      const first = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
      const second = await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
      expect(spawns).toHaveLength(1)
      expect(second.createdAt).toBe(first.createdAt)
    })

    it("force re-runs even on an unchanged head", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      const env = envFor("sha-one", layer)
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
      await Effect.runPromise(reviewRun("s1", true).pipe(Effect.provide(env)))
      expect(spawns).toHaveLength(2)
    })

    it("re-reviews once the PR head advances", async () => {
      withSession()
      const { layer, spawns } = countingAdapter()
      await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer))))
      const second = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-two", layer)))
      )
      expect(spawns).toHaveLength(2)
      expect(second.headSha).toBe("sha-two")
    })

    it("honours a configured review model", async () => {
      withSession()
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "config.json"),
        JSON.stringify({
          reposDir: "/repos",
          createdAt: "2026-01-01T00:00:00.000Z",
          github: {
            enabled: true,
            autoCreatePr: false,
            autoDetectPr: true,
            reviewCli: "claude",
            reviewModel: "claude-opus-4-8"
          }
        })
      )
      const { layer, spawns } = countingAdapter()
      const review = await Effect.runPromise(
        reviewRun("s1", false).pipe(Effect.provide(envFor("sha-one", layer)))
      )
      expect(review.model).toBe("claude-opus-4-8")
      expect(spawns[0]!.model).toBe("claude-opus-4-8")
    })

    /**
     * Posting the low-severity half to the PR.
     *
     * The payload's SHAPE is `planReviewPost`'s business and is pinned there
     * (review-post.test.ts) — the fake executor drains stdin, so the fed JSON
     * isn't observable here anyway. What these pin is the handler's job: does it
     * call GitHub at all, on which path, and what does it stamp on the review.
     */
    describe("posting to the PR", () => {
      /** A diff whose new side has lines 1–3, so a finding can actually anchor. */
      const POSTABLE_DIFF = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1,3 @@",
        " one",
        "+two",
        "+three"
      ].join("\n")

      /** `gh` that records every invocation, and can fail the review POST. */
      const recordingGh = (headSha: string, opts: { postFails?: boolean } = {}) => {
        const calls: Array<ReadonlyArray<string>> = []
        const layer = fakeCommandExecutor((cmd, args) => {
          if (cmd === "which" || cmd === "where") {
            return args[0] === "claude" ? { stdout: "/usr/local/bin/claude" } : { stdout: "" }
          }
          if (cmd !== "gh") return { stdout: "2.1.0" }
          calls.push([...args])
          if (args[1] === "view") return { stdout: JSON.stringify({ headRefOid: headSha }) }
          if (args[1] === "diff") return { stdout: POSTABLE_DIFF }
          if (args[0] === "api" && args.includes("--method")) {
            return opts.postFails
              ? { exitCode: 1, stderr: "HTTP 422: line must be part of the diff" }
              : { stdout: "{}" }
          }
          return { stdout: "" }
        })
        return { calls, layer }
      }

      /** A reviewer stub reporting exactly `findings`. */
      const adapterReporting = (findings: ReadonlyArray<Record<string, unknown>>) =>
        Layer.succeed(
          CliAdapter,
          CliAdapter.of({
            run: ((_id: string, _spec: SessionSpec, ctx: AgentContext) =>
              ctx.emit({
                _tag: "Assistant",
                text: `\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``
              })) as CliAdapterShape["run"],
            stop: () => Effect.void
          })
        )

      const envWith = (gh: Layer.Layer<CommandExecutor.CommandExecutor>, adapter: Layer.Layer<CliAdapter>) =>
        Layer.mergeAll(Layer.succeed(AppPaths, appPathsFor(root)), NodeContext.layer, gh).pipe(
          (leaf) =>
            Layer.mergeAll(
              ConfigService.Default,
              SessionStore.Default,
              GhService.Default,
              ReviewStore.Default,
              ReviewService.Default,
              DiscoveryService.Default,
              adapter
            ).pipe(Layer.provideMerge(leaf))
        )

      const isReviewPost = (args: ReadonlyArray<string>) =>
        args[0] === "api" && args.some((a) => a.endsWith("/reviews"))

      it("posts the minor/nit findings and stamps postedAt", async () => {
        withSession()
        const { calls, layer: gh } = recordingGh("sha-one")
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(gh, adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }]))
            )
          )
        )
        expect(calls.filter(isReviewPost)).toHaveLength(1)
        expect(review.postedAt).not.toBeNull()
        expect(review.postError).toBeNull()
      })

      // The critical/major half belongs to the agent. Posting it here would both
      // duplicate it and turn the reviewer into a PR spammer.
      it("posts nothing when every finding is critical or major", async () => {
        withSession()
        const { calls, layer: gh } = recordingGh("sha-one")
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(gh, adapterReporting([{ title: "Data loss", severity: "critical", path: "a.ts", line: 2 }]))
            )
          )
        )
        expect(calls.filter(isReviewPost)).toHaveLength(0)
        expect(review.postedAt).toBeNull()
        expect(review.postError).toBeNull()
      })

      /**
       * The best-effort guarantee. Failing the run instead would throw away a
       * review that cost real tokens AND (because the caller only persists on
       * success) leave the auto-trigger re-spawning the reviewer every tick.
       */
      it("keeps the review and records postError when GitHub rejects the post", async () => {
        withSession()
        const { layer: gh } = recordingGh("sha-one", { postFails: true })
        const review = await Effect.runPromise(
          reviewRun("s1", false).pipe(
            Effect.provide(
              envWith(gh, adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }]))
            )
          )
        )
        expect(review.findings).toHaveLength(1)
        expect(review.postedAt).toBeNull()
        expect(review.postError).toContain("HTTP 422")
      })

      it("persists the failed post so the UI still sees it after a reload", async () => {
        withSession()
        const { layer: gh } = recordingGh("sha-one", { postFails: true })
        const env = envWith(
          gh,
          adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }])
        )
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        const stored = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(env)))
        expect(stored?.postError).toContain("HTTP 422")
      })

      /**
       * The de-dupe path must not re-post. Without this the auto-review poll
       * would add the same nits to the PR every 60 seconds, forever.
       */
      it("does not re-post when the head is unchanged", async () => {
        withSession()
        const { calls, layer: gh } = recordingGh("sha-one")
        const env = envWith(
          gh,
          adapterReporting([{ title: "Prefer const", severity: "nit", path: "a.ts", line: 2 }])
        )
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(env)))
        expect(calls.filter(isReviewPost)).toHaveLength(1)
      })
    })

    /**
     * The stamp that makes auto-routing idempotent across reloads. The renderer
     * does the routing (it owns the conversation actor); main only remembers.
     */
    describe("Review.markRouted", () => {
      const env = () =>
        Layer.mergeAll(Layer.succeed(AppPaths, appPathsFor(root)), NodeContext.layer, fakeGh("sha-one")).pipe(
          (leaf) =>
            Layer.mergeAll(
              ConfigService.Default,
              SessionStore.Default,
              GhService.Default,
              ReviewStore.Default,
              ReviewService.Default,
              DiscoveryService.Default,
              countingAdapter().layer
            ).pipe(Layer.provideMerge(leaf))
        )

      it("stamps an unrouted review and persists it", async () => {
        withSession()
        const layer = env()
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(layer)))
        const stamp = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(layer)))
        expect(stamp).not.toBeNull()
        const stored = await Effect.runPromise(reviewGet("s1").pipe(Effect.provide(layer)))
        expect(stored?.routedAt).toBe(stamp)
      })

      /**
       * The renderer calls this from an effect, and an effect can fire twice
       * (StrictMode, two panes on one session). The stamp is a fact about the
       * FIRST routing — a second call must not move it.
       */
      it("keeps the original stamp when called again", async () => {
        withSession()
        const layer = env()
        await Effect.runPromise(reviewRun("s1", false).pipe(Effect.provide(layer)))
        const first = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(layer)))
        const second = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(layer)))
        expect(second).toBe(first)
      })

      // Null, not a stamp: claiming "routed" for a review that doesn't exist
      // would leave findings reading as sent that no agent ever heard about.
      it("returns null when there is no stored review", async () => {
        withSession()
        const stamp = await Effect.runPromise(reviewMarkRouted("s1").pipe(Effect.provide(env())))
        expect(stamp).toBeNull()
      })

      /**
       * The end-to-end refutation of "a failed persist makes markRouted return
       * null forever, so routing re-sends indefinitely".
       *
       * It can't. `ReviewStore.set` updates its in-memory mirror UNCONDITIONALLY
       * (that write is the de-dupe's brake and provably cannot fail), and only
       * the DISK write is best-effort. So a `reviewRun` whose reviews dir is
       * unwritable still leaves the mirror holding the review — and
       * `reviewMarkRouted`, which reads through the same process's mirror, stamps
       * it just fine. The disk failure costs durability across a restart, not the
       * stamp; and across a restart the renderer re-reads null too, so it never
       * routes a review main has forgotten.
       */
      it("stamps a routedAt even when the reviews dir is unwritable", async () => {
        withSession()
        // A file where the reviews DIRECTORY should be → every write beneath it
        // fails, exactly like a permissions/full-disk failure.
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "reviews"), "not a directory")
        // BOTH calls under ONE layer build, which is the whole point: production
        // runs every RPC on a single `ManagedRuntime.make(AppLayer)`, so the
        // ReviewStore — and its in-memory mirror — is a process singleton shared
        // across reviewRun and reviewMarkRouted. Providing the layer per
        // `runPromise` would build a fresh, empty mirror each time and prove
        // nothing about the real code.
        const stamp = await Effect.runPromise(
          Effect.gen(function* () {
            yield* reviewRun("s1", false)
            return yield* reviewMarkRouted("s1")
          }).pipe(Effect.provide(env()))
        )
        expect(stamp).not.toBeNull()
      })
    })
  })
})

import { CliExecError, planStageSemanticFingerprint } from "@jingler/core"
import type { CliKind, WorkerActivity } from "@jingler/core"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { CliAdapter } from "./adapter.js"
import type { AgentContext, CliAdapterShape, SessionSpec } from "./adapter.js"
import {
  buildOrchestrationGroups,
  OrchestrationPersistenceError,
  OrchestrationService,
  WORKER_ACTIVITY_FEED_CAP,
  WORKER_ACTIVITY_LIVE_CAP,
  WORKER_ACTIVITY_REPLAY_CAP,
  orchestrationWorkerMachine,
  recoverOrchestrationCheckpoints
} from "./orchestration-service.js"
import type {
  OrchestrationAssignment,
  OrchestrationCheckpoint,
  OrchestrationExecuteInput,
  OrchestrationSessionSpecRequest,
  OrchestrationStage
} from "./orchestration-service.js"

const assignment = (
  agentId: string,
  harness: CliKind = "codex",
  model = "worker-model"
): OrchestrationAssignment => ({
  agentId,
  cli: harness,
  model,
  reason: "Test route"
})

const stage = (
  id: string,
  agentId: string,
  options: {
    readonly dependsOn?: ReadonlyArray<string>
    readonly files?: ReadonlyArray<string>
    readonly harness?: CliKind
    readonly declaresFiles?: boolean
  } = {}
): OrchestrationStage => ({
  id,
  title: `Stage ${id}`,
  intent: `Complete ${id}`,
  approach: [],
  files:
    options.declaresFiles === false
      ? []
      : (options.files ?? []).map((file) => ({ path: file, change: "M" as const })),
  diagrams: [],
  notes: [{ kind: "prose", id: `${id}-note`, text: `Implement ${id}` }],
  acceptance: [
    {
      id: `${id}.1`,
      text: `Stage ${id} works`,
      status: "pending",
      evidence: null
    }
  ],
  dependencies: options.dependsOn ?? [],
  complexity: "medium",
  assignment: assignment(agentId, options.harness),
  executionStatus: "queued"
})

const sessionSpec = (request: OrchestrationSessionSpecRequest): SessionSpec => ({
  cli: request.group.assignment.cli,
  repo: "jingler",
  branch: "feature/orchestration",
  cwd: "/tmp/jingler",
  prompt: request.prompt,
  images: [],
  binPath: "/usr/bin/fake-harness",
  mode: "auto",
  model: request.group.assignment.model,
  resumeId: request.resumeId
})

const input = (
  stages: ReadonlyArray<OrchestrationStage>,
  overrides: Partial<OrchestrationExecuteInput> = {}
): OrchestrationExecuteInput => ({
  sessionId: "session-1",
  planId: "plan-1",
  producingChatId: "chat-1",
  planRevision: 7,
  stages,
  makeSessionSpec: sessionSpec,
  ...overrides
})

const layerFor = (adapter: CliAdapterShape) =>
  OrchestrationService.Default.pipe(
    Layer.provide(Layer.succeed(CliAdapter, CliAdapter.of(adapter)))
  )

const passCurrentStage = (
  spec: SessionSpec,
  context: AgentContext
): Effect.Effect<void> => {
  const criterionId = /Criteria: (\S+)/.exec(spec.prompt)?.[1] ?? "missing"
  return Effect.gen(function* () {
    yield* context.emit({
      _tag: "Assistant",
      text: `PLAN_RESULT criterion=${criterionId} status=passed evidence=targeted verification passed`
    })
    yield* context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
  })
}

describe("orchestrationWorkerMachine", () => {
  it("models the legal worker lifecycle and retry transition", () => {
    const actor = createActor(orchestrationWorkerMachine).start()
    expect(actor.getSnapshot().value).toBe("queued")
    actor.send({ type: "START" })
    expect(actor.getSnapshot().value).toBe("running")
    actor.send({ type: "BLOCK" })
    expect(actor.getSnapshot().value).toBe("blocked")
    actor.send({ type: "RETRY" })
    expect(actor.getSnapshot().value).toBe("queued")
    actor.send({ type: "START" })
    actor.send({ type: "COMPLETE" })
    expect(actor.getSnapshot().value).toBe("completed")
  })
})

describe("orchestration graph", () => {
  it("groups dependency chains under one agent and keeps independent work parallel", () => {
    const result = buildOrchestrationGroups([
      stage("01", "agent-a"),
      stage("02", "agent-a", { dependsOn: ["01"] }),
      stage("03", "agent-b")
    ])

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.groups.map((group) => group.stages.map((item) => item.id))).toEqual([
      ["01", "02"],
      ["03"]
    ])
  })

  it("serializes declared file overlap and reports conflicting routes", () => {
    const result = buildOrchestrationGroups([
      stage("01", "agent-a", { files: ["src/shared.ts"] }),
      stage("02", "agent-b", { files: ["src/shared.ts"] })
    ])

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.issues).toContainEqual({
      code: "assignment-conflict",
      stageId: "01",
      message:
        'Connected stages "01", "02" must use the same agent, harness, and model.'
    })
  })

  it("rejects missing dependencies and cycles with actionable stage ids", () => {
    const missing = buildOrchestrationGroups([
      stage("01", "agent-a", { dependsOn: ["missing"] })
    ])
    const cycle = buildOrchestrationGroups([
      stage("01", "agent-a", { dependsOn: ["02"] }),
      stage("02", "agent-a", { dependsOn: ["01"] })
    ])

    expect(missing.valid).toBe(false)
    expect(cycle.valid).toBe(false)
    if (missing.valid || cycle.valid) return
    expect(missing.issues[0]?.code).toBe("dangling-dependency")
    expect(cycle.issues.map((issue) => issue.stageId)).toContain("01")
  })
})

describe("OrchestrationService", () => {
  it("streams ordered task progress and rejects foreign or stale task ids", async () => {
    const currentStage: OrchestrationStage = {
      ...stage("01", "agent-a"),
      tasks: [
        { id: "01.task.1", text: "Add the protocol", status: "pending" },
        { id: "01.task.2", text: "Verify live updates", status: "pending" }
      ]
    }
    const updates: Array<{
      readonly taskId: string
      readonly status: string
      readonly stageFingerprint: string
    }> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          const fingerprint = /PLAN_TASK stage=01 fingerprint=(\S+) task=<task-id>/.exec(
            spec.prompt
          )?.[1]
          expect(fingerprint).toBeDefined()
          yield* context.emit({
            _tag: "Assistant",
            text: [
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.1 status=in-progress`,
              `PLAN_TASK stage=02 fingerprint=${fingerprint} task=01.task.1 status=completed`,
              `PLAN_TASK stage=01 fingerprint=stale task=01.task.1 status=completed`,
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=foreign.task status=completed`,
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.2 status=in-progress`,
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.1 status=completed`,
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.2 status=in-progress`
            ].join("\n")
          })
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* OrchestrationService
        return yield* service.execute(
          input([currentStage], {
            callbacks: {
              onTaskState: (update) =>
                Effect.sync(() => {
                  updates.push({
                    taskId: update.taskId,
                    status: update.status,
                    stageFingerprint: update.stageFingerprint
                  })
                })
            }
          })
        )
      }).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(report.workers[0]?.status).toBe("completed")
    expect(updates).toEqual([
      {
        taskId: "01.task.1",
        status: "in-progress",
        stageFingerprint: planStageSemanticFingerprint(currentStage)
      },
      {
        taskId: "01.task.1",
        status: "completed",
        stageFingerprint: planStageSemanticFingerprint(currentStage)
      },
      {
        taskId: "01.task.2",
        status: "in-progress",
        stageFingerprint: planStageSemanticFingerprint(currentStage)
      },
      {
        taskId: "01.task.2",
        status: "completed",
        stageFingerprint: planStageSemanticFingerprint(currentStage)
      }
    ])
  })

  it("restores task progress from the canonical plan after restart", async () => {
    const queuedStage: OrchestrationStage = {
      ...stage("01", "agent-a"),
      tasks: [
        { id: "01.task.1", text: "Persist the first change", status: "pending" },
        { id: "01.task.2", text: "Resume the worker", status: "pending" },
        { id: "01.task.3", text: "Finish verification", status: "pending" }
      ]
    }
    const canonicalStage: OrchestrationStage = {
      ...queuedStage,
      tasks: [
        { id: "01.task.1", text: "Persist the first change", status: "completed" },
        { id: "01.task.2", text: "Resume the worker", status: "in-progress" },
        { id: "01.task.3", text: "Finish verification", status: "pending" }
      ]
    }
    const updates: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          expect(spec.resumeId).toBe("resume-after-restart")
          expect(spec.prompt).toContain("1. [completed] 01.task.1")
          expect(spec.prompt).toContain("2. [in-progress] 01.task.2")
          const fingerprint = /PLAN_TASK stage=01 fingerprint=(\S+) task=<task-id>/.exec(
            spec.prompt
          )?.[1]
          yield* context.emit({
            _tag: "Assistant",
            text: [
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.1 status=in-progress`,
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.2 status=completed`,
              `PLAN_TASK stage=01 fingerprint=${fingerprint} task=01.task.3 status=in-progress`
            ].join("\n")
          })
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* OrchestrationService
        return yield* service.execute(
          input([queuedStage], {
            checkpoints: [
              {
                agentId: "agent-a",
                state: "interrupted",
                completedStageIds: [],
                resumeId: "resume-after-restart",
                message: "The desktop process stopped.",
                attempt: 1
              }
            ],
            refreshStage: () => Effect.succeed(canonicalStage),
            callbacks: {
              onTaskState: (update) =>
                Effect.sync(() => {
                  updates.push(`${update.taskId}:${update.status}`)
                })
            }
          })
        )
      }).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(report.workers[0]?.status).toBe("completed")
    expect(updates).toEqual([
      "01.task.2:completed",
      "01.task.3:in-progress",
      "01.task.3:completed"
    ])
  })

  it("projects live worker and nested-agent routes, steers the owner, and rejects stale ids", async () => {
    const ready = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const steers: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          if (context.registerTurnSteer !== undefined) {
            yield* context.registerTurnSteer(async (text) => {
              steers.push(text)
              await Effect.runPromise(
                context.emit({
                  _tag: "Assistant",
                  text: "Nested agent checked the parser."
                })
              )
              return "accepted"
            })
          }
          yield* context.emit({
            _tag: "SubagentStarted",
            id: "task-parser",
            name: "Explore",
            description: "Inspect the parser",
            parentId: null
          })
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* OrchestrationService
        const execution = yield* service
          .execute(input([stage("01", "agent-a")]))
          .pipe(Effect.fork)
        yield* Deferred.await(ready)
        const participants = yield* service.planParticipants(
          "session-1",
          "plan-1"
        )
        const nested = participants.find(
          (participant) => participant.role === "subagent"
        )!
        const routed = yield* service.steerPlanParticipant({
          sessionId: "session-1",
          planId: "plan-1",
          routingId: nested.routingId,
          text: "Relay this to the nested parser agent."
        })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(execution)
        const stale = yield* service.steerPlanParticipant({
          sessionId: "session-1",
          planId: "plan-1",
          routingId: nested.routingId,
          text: "Try again."
        })
        return { participants, routed, stale }
      }).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(result.participants.map((participant) => participant.role)).toEqual([
      "worker",
      "subagent"
    ])
    expect(new Set(result.participants.map((participant) => participant.routingId)).size).toBe(2)
    expect(steers).toEqual(["Relay this to the nested parser agent."])
    expect(result.routed).toEqual({
      status: "delivered",
      reply: "Nested agent checked the parser."
    })
    expect(result.stale.status).toBe("unavailable")
  })

  it("serializes concurrent reply-bearing steers and keeps each streamed reply intact", async () => {
    const ready = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const steers: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          yield* context.registerTurnSteer?.(async (text) => {
            steers.push(text)
            setTimeout(() => {
              Effect.runFork(context.emit({ _tag: "Assistant", text: `${text}:a` }))
            }, 10)
            setTimeout(() => {
              Effect.runFork(context.emit({ _tag: "Assistant", text: ":b" }))
            }, 100)
            return "accepted"
          }) ?? Effect.void
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* OrchestrationService
        const execution = yield* service.execute(input([stage("01", "agent-a")])).pipe(Effect.fork)
        yield* Deferred.await(ready)
        const participant = (yield* service.planParticipants("session-1", "plan-1"))[0]!
        const first = yield* service.steerPlanParticipant({
          sessionId: "session-1",
          planId: "plan-1",
          routingId: participant.routingId,
          text: "first"
        }).pipe(Effect.fork)
        yield* Effect.sleep("20 millis")
        const second = yield* service.steerPlanParticipant({
          sessionId: "session-1",
          planId: "plan-1",
          routingId: participant.routingId,
          text: "second"
        }).pipe(Effect.fork)
        const replies = [yield* Fiber.join(first), yield* Fiber.join(second)]
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(execution)
        return replies
      }).pipe(Effect.provide(layerFor(adapter)), Effect.timeout("10 seconds"))
    )

    expect(steers).toEqual(["first", "second"])
    expect(result).toEqual([
      { status: "delivered", reply: "first:a:b" },
      { status: "delivered", reply: "second:a:b" }
    ])
  })

  it("runs independent workers concurrently under distinct reservation owners", async () => {
    let active = 0
    let maximum = 0
    const owners: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (ownerId, _spec, context) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            owners.push(ownerId)
            active += 1
            maximum = Math.max(maximum, active)
          })
          yield* context.emit({ _tag: "Started", sessionId: `resume:${ownerId}` })
          yield* Effect.sleep(20)
          yield* passCurrentStage(_spec, context)
          yield* Effect.sync(() => {
            active -= 1
          })
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a"), stage("02", "agent-b")])
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(maximum).toBe(2)
    expect(new Set(owners)).toEqual(
      new Set([
        "session:session-1:plan:plan-1:agent:agent-a",
        "session:session-1:plan:plan-1:agent:agent-b"
      ])
    )
    expect(report.workers.map((worker) => worker.status)).toEqual([
      "completed",
      "completed"
    ])
  })

  it("runs dependent stages in order with the same key and resume identity", async () => {
    const runs: Array<{
      readonly ownerId: string
      readonly resumeId: string | null
      readonly prompt: string
    }> = []
    const adapter: CliAdapterShape = {
      run: (ownerId, spec, context) =>
        Effect.gen(function* () {
          runs.push({ ownerId, resumeId: spec.resumeId, prompt: spec.prompt })
          yield* context.emit({ _tag: "Started", sessionId: "resume-agent-a" })
          yield* context.emit({
            _tag: "Assistant",
            text: `PLAN_RESULT criterion=${spec.prompt.includes("Stage: 01") ? "01.1" : "02.1"} status=passed evidence=targeted test passed`
          })
          yield* context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([
          stage("01", "agent-a"),
          stage("02", "agent-a", { dependsOn: ["01"] })
        ])
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(runs.map((run) => run.ownerId)).toEqual([
      "session:session-1:plan:plan-1:agent:agent-a",
      "session:session-1:plan:plan-1:agent:agent-a"
    ])
    expect(runs.map((run) => run.resumeId)).toEqual([null, "resume-agent-a"])
    expect(runs[0]?.prompt).toContain("Stage: 01")
    expect(runs[1]?.prompt).toContain("Stage: 02")
    expect(report.workers[0]?.evidence.map((value) => value.criterionId)).toEqual([
      "01.1",
      "02.1"
    ])
  })

  it("keeps sibling workers running when one is blocked", async () => {
    const states: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        spec.prompt.includes("Stage: blocked")
          ? Effect.fail(
              new CliExecError({
                kind: spec.cli,
                message: "Authentication failed: sign in required"
              })
            )
          : Effect.sleep(25).pipe(
              Effect.zipRight(
                passCurrentStage(spec, context)
              )
            ),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("blocked", "agent-a"), stage("healthy", "agent-b")], {
          callbacks: {
            onWorkerState: (update) =>
              Effect.sync(() => {
                states.push(`${update.agentId}:${update.status}`)
              })
          }
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(report.workers.map((worker) => worker.status)).toEqual([
      "blocked",
      "completed"
    ])
    expect(states).toContain("agent-b:running")
    expect(states).toContain("agent-b:completed")
  })

  it("retries only unfinished stages and preserves the worker resume identity", async () => {
    let stageTwoAttempts = 0
    const calls: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => {
        const id = spec.prompt.includes("Stage: 01") ? "01" : "02"
        calls.push(id)
        if (id === "02" && stageTwoAttempts++ === 0) {
          return Effect.fail(
            new CliExecError({ kind: spec.cli, message: "Compilation failed" })
          )
        }
        return Effect.gen(function* () {
          yield* context.emit({ _tag: "Started", sessionId: "resume-agent-a" })
          yield* passCurrentStage(spec, context)
        })
      },
      stop: () => Effect.void
    }
    const serviceLayer = layerFor(adapter)
    const stages = [
      stage("01", "agent-a"),
      stage("02", "agent-a", { dependsOn: ["01"] })
    ]
    const checkpoints = new Map<string, OrchestrationCheckpoint>()
    const callbacks = {
      onCheckpoint: (checkpoint: OrchestrationCheckpoint) =>
        Effect.sync(() => {
          checkpoints.set(checkpoint.agentId, checkpoint)
        })
    }
    const program = Effect.gen(function* () {
      const first = yield* OrchestrationService.execute(
        input(stages, { callbacks })
      )
      const retryReport = yield* OrchestrationService.execute(
        input(stages, {
          callbacks,
          checkpoints: [...checkpoints.values()],
          agentIds: ["agent-a"]
        })
      )
      const retried = retryReport.workers[0]!
      return { first, retried }
    }).pipe(Effect.provide(serviceLayer))

    const result = await Effect.runPromise(program)
    expect(result.first.workers[0]?.status).toBe("failed")
    expect(result.retried.status).toBe("completed")
    expect(result.retried.resumeId).toBe("resume-agent-a")
    expect(calls).toEqual(["01", "02", "02"])
  })

  it("refreshes a dependent stage from the canonical plan at its boundary", async () => {
    const prompts: Array<string> = []
    const initialSecond = stage("02", "agent-a", { dependsOn: ["01"] })
    const amendedSecond = {
      ...initialSecond,
      intent: "Complete the user amendment with the existing worker"
    }
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => {
        prompts.push(spec.prompt)
        return passCurrentStage(spec, context)
      },
      stop: () => Effect.void
    }

    await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a"), initialSecond], {
          refreshStage: (_agentId, stageId) =>
            Effect.succeed(
              stageId === "02"
                ? amendedSecond
                : stage("01", "agent-a")
            )
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(prompts[1]).toContain(
      "Complete the user amendment with the existing worker"
    )
  })

  it("skips a queued stage removed before its execution boundary", async () => {
    const prompts: Array<string> = []
    const states: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => {
        prompts.push(spec.prompt)
        return passCurrentStage(spec, context)
      },
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([
          stage("01", "agent-a"),
          stage("02", "agent-a", { dependsOn: ["01"] })
        ], {
          refreshStage: (_agentId, stageId) =>
            Effect.succeed(stageId === "01" ? stage("01", "agent-a") : null),
          callbacks: {
            onStageState: (update) =>
              Effect.sync(() => states.push(`${update.stageId}:${update.status}`))
          }
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(prompts).toHaveLength(1)
    expect(states).toContain("02:skipped")
    expect(report.workers[0]?.completedStageIds).toEqual(["01"])
  })

  it("preserves assistant event boundaries while parsing evidence", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, _spec, context) =>
        Effect.gen(function* () {
          yield* context.emit({ _tag: "Assistant", text: "Verification complete." })
          yield* context.emit({
            _tag: "Assistant",
            text:
              "PLAN_RESULT criterion=01.1 status=passed evidence=targeted test passed"
          })
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(input([stage("01", "agent-a")])).pipe(
        Effect.provide(layerFor(adapter))
      )
    )

    expect(report.workers[0]?.status).toBe("completed")
  })

  it("discards evidence when a stage changes during its harness run", async () => {
    const original = stage("01", "agent-a")
    const amended = {
      ...original,
      intent: "Complete the amended requirement"
    }
    let refreshes = 0
    const evidence: Array<string> = []
    const states: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => passCurrentStage(spec, context),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([original], {
          refreshStage: () =>
            Effect.sync(() => refreshes++ === 0 ? original : amended),
          callbacks: {
            onEvidence: (item) =>
              Effect.sync(() => evidence.push(item.criterionId)),
            onStageState: (update) =>
              Effect.sync(() => states.push(update.status))
          }
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(report.workers[0]?.status).toBe("interrupted")
    expect(evidence).toEqual([])
    expect(states).toEqual(["running", "interrupted"])
  })

  it("uses identical execution semantics for Claude, Codex, and OpenCode", async () => {
    const harnesses: ReadonlyArray<CliKind> = ["claude", "codex", "opencode"]
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        passCurrentStage(spec, context),
      stop: () => Effect.void
    }

    const reports = await Promise.all(
      harnesses.map((harness) =>
        Effect.runPromise(
          OrchestrationService.execute(
            input([
              stage("01", "agent-a", { harness }),
              stage("02", "agent-a", { dependsOn: ["01"], harness }),
              stage("03", "agent-b", { harness })
            ], {
              planId: `plan-${harness}`
            })
          ).pipe(Effect.provide(layerFor(adapter)))
        )
      )
    )

    expect(
      reports.map((report) =>
        report.workers.map((worker) => ({
          agentId: worker.agentId,
          status: worker.status,
          completed: worker.completedStageIds
        }))
      )
    ).toEqual([
      [
        { agentId: "agent-a", status: "completed", completed: ["01", "02"] },
        { agentId: "agent-b", status: "completed", completed: ["03"] }
      ],
      [
        { agentId: "agent-a", status: "completed", completed: ["01", "02"] },
        { agentId: "agent-b", status: "completed", completed: ["03"] }
      ],
      [
        { agentId: "agent-a", status: "completed", completed: ["01", "02"] },
        { agentId: "agent-b", status: "completed", completed: ["03"] }
      ]
    ])
  })

  it.each([
    {
      name: "missing evidence",
      output: "",
      message: "has no PLAN_RESULT evidence"
    },
    {
      name: "malformed evidence",
      output: "PLAN_RESULT criterion=01.1 status=passed",
      message: "malformed"
    },
    {
      name: "explicitly failed evidence",
      output:
        "PLAN_RESULT criterion=01.1 status=failed evidence=verification failed",
      message: "was reported failed"
    },
    {
      name: "another stage's evidence",
      output:
        "PLAN_RESULT criterion=02.1 status=passed evidence=wrong owner",
      message: "does not belong"
    }
  ])("leaves a stage retryable for $name", async ({ output, message }) => {
    const persisted: Array<string> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, _spec, context) =>
        Effect.gen(function* () {
          if (output.length > 0) {
            yield* context.emit({ _tag: "Assistant", text: output })
          }
          yield* context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a")], {
          callbacks: {
            onEvidence: (evidence) =>
              Effect.sync(() => persisted.push(evidence.criterionId))
          }
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(report.workers[0]).toMatchObject({
      status: "failed",
      completedStageIds: [],
      message: expect.stringContaining(message)
    })
    if (message === "does not belong" || message === "malformed") {
      expect(persisted).toEqual([])
    }
  })

  it("interrupts the harness and waits for teardown when a worker is stopped", async () => {
    let started = false
    let finalized = false
    const adapter: CliAdapterShape = {
      run: () =>
        Effect.sync(() => {
          started = true
        }).pipe(
          Effect.zipRight(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true
            })
          )
        ),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const execution = yield* Effect.fork(
        OrchestrationService.execute(input([stage("01", "agent-a")]))
      )
      while (!started) yield* Effect.yieldNow()
      yield* OrchestrationService.stopWorker({
        sessionId: "session-1",
        planId: "plan-1",
        agentId: "agent-a"
      })
      return yield* Fiber.join(execution)
    })

    const report = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
    expect(finalized).toBe(true)
    expect(report.workers[0]?.status).toBe("interrupted")
  })

  it("stops immediately when an unattended worker asks for operator input", async () => {
    let mutatedAfterQuestion = false
    const adapter: CliAdapterShape = {
      run: (_ownerId, _spec, context) =>
        Effect.gen(function* () {
          yield* context.askQuestion({
            id: "q1",
            questions: [
              {
                question: "Which implementation?",
                header: "Choice",
                options: [],
                multiSelect: false
              }
            ]
          })
          mutatedAfterQuestion = true
        }),
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a")])
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(mutatedAfterQuestion).toBe(false)
    expect(report.workers[0]).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("operator input")
    })
  })

  it("retains a first-stage resume identity when that stage fails", async () => {
    let attempt = 0
    const observedResumeIds: Array<string | null> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          observedResumeIds.push(spec.resumeId)
          if (attempt++ === 0) {
            yield* context.emit({
              _tag: "Started",
              sessionId: "resume-first-stage"
            })
            return yield* Effect.fail(
              new CliExecError({
                kind: spec.cli,
                message: "First attempt failed"
              })
            )
          }
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }
    const stages = [stage("01", "agent-a")]
    const checkpoints = new Map<string, OrchestrationCheckpoint>()
    const callbacks = {
      onCheckpoint: (checkpoint: OrchestrationCheckpoint) =>
        Effect.sync(() => {
          checkpoints.set(checkpoint.agentId, checkpoint)
        })
    }
    const program = Effect.gen(function* () {
      const first = yield* OrchestrationService.execute(
        input(stages, { callbacks })
      )
      const retryReport = yield* OrchestrationService.execute(
        input(stages, {
          callbacks,
          checkpoints: [...checkpoints.values()],
          agentIds: ["agent-a"]
        })
      )
      const retried = retryReport.workers[0]!
      return { first, retried }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
    expect(result.first.workers[0]?.status).toBe("failed")
    expect(result.retried.status).toBe("completed")
    expect(observedResumeIds).toEqual([null, "resume-first-stage"])
  })

  it("reconstructs a targeted retry from a durable checkpoint", async () => {
    const observed: Array<{ ownerId: string; resumeId: string | null }> = []
    const adapter: CliAdapterShape = {
      run: (ownerId, spec, context) => {
        observed.push({ ownerId, resumeId: spec.resumeId })
        return passCurrentStage(spec, context)
      },
      stop: () => Effect.void
    }

    const report = await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a"), stage("02", "agent-b")], {
          agentIds: ["agent-a"],
          checkpoints: [
            {
              agentId: "agent-a",
              state: "interrupted",
              completedStageIds: [],
              resumeId: "durable-resume",
              message: "Desktop restarted.",
              attempt: 2
            }
          ]
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(report.workers.map((worker) => worker.agentId)).toEqual(["agent-a"])
    expect(observed).toEqual([
      {
        ownerId: "session:session-1:plan:plan-1:agent:agent-a",
        resumeId: "durable-resume"
      }
    ])
  })

  it("refuses a second execution while the same plan still has live workers", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.sleep(30).pipe(
          Effect.zipRight(passCurrentStage(spec, context))
        ),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const first = yield* Effect.fork(
        OrchestrationService.execute(input([stage("01", "agent-a")]))
      )
      yield* Effect.sleep(5)
      const second = yield* OrchestrationService.execute(
        input([stage("01", "agent-a")])
      ).pipe(Effect.either)
      const completed = yield* Fiber.join(first)
      return { second, completed }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
    expect(result.second._tag).toBe("Left")
    if (result.second._tag === "Left") {
      expect(result.second.left._tag).toBe(
        "OrchestrationAlreadyRunningError"
      )
    }
    expect(result.completed.workers[0]?.status).toBe("completed")
  })

  it("scopes identical plan ids to their owning sessions", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.sleep(15).pipe(Effect.zipRight(passCurrentStage(spec, context))),
      stop: () => Effect.void
    }
    const program = Effect.all(
      [
        OrchestrationService.execute(
          input([stage("01", "agent-a")], { sessionId: "session-a" })
        ),
        OrchestrationService.execute(
          input([stage("01", "agent-a")], { sessionId: "session-b" })
        )
      ],
      { concurrency: "unbounded" }
    )

    const reports = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )

    expect(reports.map((report) => report.workers[0]?.status)).toEqual([
      "completed",
      "completed"
    ])
    expect(reports[0]?.workers[0]?.ownerId).not.toBe(
      reports[1]?.workers[0]?.ownerId
    )
  })

  it("checkpoints a Started resume id before the provider turn settles", async () => {
    const checkpoints: Array<OrchestrationCheckpoint> = []
    const adapter: CliAdapterShape = {
      run: (_ownerId, _spec, context) =>
        context
          .emit({ _tag: "Started", sessionId: "durable-in-flight-resume" })
          .pipe(Effect.zipRight(Effect.never)),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const execution = yield* Effect.fork(
        OrchestrationService.execute(
          input([stage("01", "agent-a")], {
            callbacks: {
              onCheckpoint: (checkpoint) =>
                Effect.sync(() => checkpoints.push(checkpoint))
            }
          })
        )
      )
      while (
        !checkpoints.some(
          (checkpoint) => checkpoint.resumeId === "durable-in-flight-resume"
        )
      ) {
        yield* Effect.yieldNow()
      }
      yield* Fiber.interrupt(execution)
    })

    await Effect.runPromise(program.pipe(Effect.provide(layerFor(adapter))))
    expect(checkpoints).toContainEqual(
      expect.objectContaining({
        state: "running",
        resumeId: "durable-in-flight-resume"
      })
    )
  })

  it("fails execution when durable progress cannot be persisted", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => passCurrentStage(spec, context),
      stop: () => Effect.void
    }
    const result = await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a")], {
          callbacks: {
            onCheckpoint: () =>
              Effect.fail(
                new OrchestrationPersistenceError({
                  message: "Checkpoint storage is unavailable."
                })
              )
          }
        })
      ).pipe(Effect.either, Effect.provide(layerFor(adapter)))
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("OrchestrationPersistenceError")
    }
  })
})

describe("OrchestrationService worker activity", () => {
  it("gives early and late watchers each event exactly once and in order", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => passCurrentStage(spec, context),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      const earlyFiber = yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(Stream.take(6), Stream.runCollect, Effect.fork)
      yield* Effect.yieldNow()
      yield* service.execute(input([stage("01", "agent-a")]))
      const early = [...(yield* Fiber.join(earlyFiber))]
      const late = [
        ...(yield* service
          .watch("session-1", "plan-1", "chat-1")
          .pipe(Stream.take(6), Stream.runCollect))
      ]
      return { early, late }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
    expect(result.early.map((activity) => activity._tag)).toEqual([
      "Reset",
      "State",
      "State",
      "HarnessEvent",
      "HarnessEvent",
      "State"
    ])
            expect(result.late.map((activity) => activity._tag)).toEqual(
                result.early.map((activity) => activity._tag),
            )
            expect(result.late[0]).toMatchObject({
                _tag: "Reset",
                mode: "replace",
                workers: [{ worker: { agentId: "agent-a" }, status: "completed" }],
            })
            expect(result.late.slice(1)).toEqual(result.early.slice(1))
  })

  it("joins buffered replay to live activity without a gap or duplicate", async () => {
    let releaseWorker = (): void => {}
    const workerReleased = new Promise<void>((resolve) => {
      releaseWorker = resolve
    })
    let firstEventPublished = false
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          yield* context.emit({ _tag: "Assistant", text: "buffered" })
          firstEventPublished = true
          yield* Effect.promise(() => workerReleased)
          yield* context.emit({ _tag: "Assistant", text: "live" })
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      const execution = yield* service
        .execute(input([stage("01", "agent-a")]))
        .pipe(Effect.fork)
      while (!firstEventPublished) yield* Effect.yieldNow()

      const watcherAttached = yield* Deferred.make<void>()
      const watcher = yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(
          Stream.tap(() => Deferred.succeed(watcherAttached, undefined)),
          Stream.take(8),
          Stream.runCollect,
          Effect.fork
        )
      yield* Deferred.await(watcherAttached)
      releaseWorker()
      yield* Fiber.join(execution)
      const replayAndLive = [...(yield* Fiber.join(watcher))]
      const lateReplay = [
        ...(yield* service
          .watch("session-1", "plan-1", "chat-1")
          .pipe(Stream.take(8), Stream.runCollect))
      ]
      return { replayAndLive, lateReplay }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
            expect(result.replayAndLive.map((activity) => activity._tag)).toEqual(
                result.lateReplay.map((activity) => activity._tag),
            )
            expect(result.replayAndLive[0]).toMatchObject({
                _tag: "Reset",
                mode: "replace",
                workers: [{ worker: { agentId: "agent-a" } }],
            })
            expect(result.lateReplay[0]).toMatchObject({
                _tag: "Reset",
                mode: "replace",
                workers: [{ worker: { agentId: "agent-a" } }],
            })
            expect(result.replayAndLive.slice(1)).toEqual(result.lateReplay.slice(1))
    expect(
      result.replayAndLive.flatMap((activity) =>
        activity._tag === "HarnessEvent" &&
        activity.event._tag === "Assistant"
          ? [activity.event.text]
          : []
      )
    ).toEqual([
      "buffered",
      "live",
      "PLAN_RESULT criterion=01.1 status=passed evidence=targeted verification passed"
    ])
  })

  it("keeps simultaneous worker identities and transcripts independently routable", async () => {
    const adapter: CliAdapterShape = {
      run: (ownerId, spec, context) => {
        const agentId = ownerId.endsWith("agent-a") ? "agent-a" : "agent-b"
        return Effect.gen(function* () {
          yield* context.emit({
            _tag: "Assistant",
            text: `${agentId}:first`
          })
          yield* Effect.yieldNow()
          yield* passCurrentStage(spec, context)
        })
      },
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      yield* service.execute(
        input([stage("01", "agent-a"), stage("02", "agent-b")])
      )
      return yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(Stream.take(13), Stream.runCollect)
    })

    const activities = [
      ...(await Effect.runPromise(
        program.pipe(Effect.provide(layerFor(adapter)))
      ))
    ]
    const transcripts = new Map<string, Array<string>>()
    for (const activity of activities) {
      if (
        activity._tag !== "HarnessEvent" ||
        activity.event._tag !== "Assistant"
      ) continue
      const chunks = transcripts.get(activity.worker.agentId) ?? []
      transcripts.set(activity.worker.agentId, [...chunks, activity.event.text])
    }
    expect(transcripts.get("agent-a")?.join("\n")).toContain("agent-a:first")
    expect(transcripts.get("agent-a")?.join("\n")).not.toContain("agent-b:first")
    expect(transcripts.get("agent-b")?.join("\n")).toContain("agent-b:first")
    expect(transcripts.get("agent-b")?.join("\n")).not.toContain("agent-a:first")
    expect(
      activities
        .filter((activity) => activity._tag !== "Reset")
        .every(
          (activity) =>
            activity.worker.planId === "plan-1" &&
            activity.worker.producingChatId === "chat-1"
        )
    ).toBe(true)
  })

  it("replaces a session replay with the next plan and keeps it in the producing chat", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => passCurrentStage(spec, context),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      yield* service.execute(input([stage("01", "agent-a")]))
      const wrongChat: Array<WorkerActivity> = []
      const wrongChatWatcher = yield* service
        .watch("session-1", "plan-2", "chat-1")
        .pipe(
          Stream.runForEach((activity) =>
            Effect.sync(() => wrongChat.push(activity))
          ),
          Effect.fork
        )
      yield* Effect.yieldNow()
      yield* service.execute(
        input([stage("02", "agent-b")], {
          planId: "plan-2",
          producingChatId: "chat-2"
        })
      )
      yield* Effect.yieldNow()
      yield* Fiber.interrupt(wrongChatWatcher)
      const replay = yield* service
        .watch("session-1", "plan-2", "chat-2")
        .pipe(Stream.take(6), Stream.runCollect)
      return { wrongChat, replay: [...replay] }
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
    expect(result.wrongChat).toEqual([])
    expect(
      result.replay.every((activity) => {
        const scope =
          activity._tag === "Reset" ? activity : activity.worker
        return (
          scope.planId === "plan-2" &&
          scope.producingChatId === "chat-2"
        )
      })
    ).toBe(true)
  })

  it("resets only a targeted retry and preserves its settled sibling", async () => {
    const attempts = new Map<string, number>()
    const checkpoints = new Map<string, OrchestrationCheckpoint>()
    const adapter: CliAdapterShape = {
      run: (ownerId, spec, context) => {
        const agentId = ownerId.endsWith("agent-a") ? "agent-a" : "agent-b"
        const attempt = (attempts.get(agentId) ?? 0) + 1
        attempts.set(agentId, attempt)
        if (agentId === "agent-a" && attempt === 1) {
          return context
            .emit({ _tag: "Assistant", text: "agent-a:first-attempt" })
            .pipe(
              Effect.zipRight(
                Effect.fail(
                  new CliExecError({
                    kind: spec.cli,
                    message: "Compilation failed"
                  })
                )
              )
            )
        }
        return passCurrentStage(spec, context)
      },
      stop: () => Effect.void
    }
    const callbacks = {
      onCheckpoint: (checkpoint: OrchestrationCheckpoint) =>
        Effect.sync(() => {
          checkpoints.set(checkpoint.agentId, checkpoint)
        })
    }
    const stages = [stage("01", "agent-a"), stage("02", "agent-b")]
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      const watcher = yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(Stream.take(16), Stream.runCollect, Effect.fork)
      yield* Effect.yieldNow()
      yield* service.execute(input(stages, { callbacks }))
      yield* service.execute(
        input(stages, {
          callbacks,
          checkpoints: [...checkpoints.values()],
          agentIds: ["agent-a"]
        })
      )
      return yield* Fiber.join(watcher)
    })

    const activities = [
      ...(await Effect.runPromise(
        program.pipe(Effect.provide(layerFor(adapter)))
      ))
    ]
    const resets = activities.filter(
      (activity): activity is Extract<WorkerActivity, { _tag: "Reset" }> =>
        activity._tag === "Reset"
    )
    expect(resets).toHaveLength(2)
    expect(resets[0]?.mode).toBe("replace")
    expect(resets[0]?.workers.map((state) => state.worker.agentId)).toEqual([
      "agent-a",
      "agent-b"
    ])
    expect(resets[1]?.mode).toBe("patch")
    expect(resets[1]?.workers).toMatchObject([
      { worker: { agentId: "agent-a", attempt: 2 }, status: "queued" }
    ])
    const retryIndex = activities.lastIndexOf(resets[1]!)
    expect(
      activities
        .slice(retryIndex + 1)
        .some(
          (activity) =>
            activity._tag !== "Reset" &&
            activity.worker.agentId === "agent-b"
        )
    ).toBe(false)
    expect(
      activities.some(
        (activity) =>
          activity._tag === "State" &&
          activity.worker.agentId === "agent-a" &&
          activity.status === "failed"
      )
    ).toBe(true)
    expect(
      activities.some(
        (activity) =>
          activity._tag === "State" &&
          activity.worker.agentId === "agent-b" &&
          activity.status === "completed"
      )
    ).toBe(true)
    expect(activities.at(-1)).toMatchObject({
      _tag: "State",
      worker: { agentId: "agent-a", attempt: 2 },
      status: "completed"
    })
  })

  it("publishes blocked and interrupted terminal states", async () => {
    const blockedAdapter: CliAdapterShape = {
      run: (_ownerId, spec) =>
        Effect.fail(
          new CliExecError({
            kind: spec.cli,
            message: "Authentication failed: sign in required"
          })
        ),
      stop: () => Effect.void
    }
    const blockedProgram = Effect.gen(function* () {
      const service = yield* OrchestrationService
      yield* service.execute(input([stage("01", "agent-a")]))
      return yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(Stream.take(4), Stream.runCollect)
    })
    const blocked = await Effect.runPromise(
      blockedProgram.pipe(Effect.provide(layerFor(blockedAdapter)))
    )
    expect([...blocked].at(-1)).toMatchObject({
      _tag: "State",
      status: "blocked"
    })

    let started = false
    const interruptedAdapter: CliAdapterShape = {
      run: () =>
        Effect.sync(() => {
          started = true
        }).pipe(Effect.zipRight(Effect.never)),
      stop: () => Effect.void
    }
    const interruptedProgram = Effect.gen(function* () {
      const service = yield* OrchestrationService
      const execution = yield* service
        .execute(input([stage("01", "agent-a")]))
        .pipe(Effect.fork)
      while (!started) yield* Effect.yieldNow()
      yield* service.stopWorker({
        sessionId: "session-1",
        planId: "plan-1",
        agentId: "agent-a"
      })
      yield* Fiber.join(execution)
      return yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(Stream.take(4), Stream.runCollect)
    })
    const interrupted = await Effect.runPromise(
      interruptedProgram.pipe(Effect.provide(layerFor(interruptedAdapter)))
    )
    expect([...interrupted].at(-1)).toMatchObject({
      _tag: "State",
      status: "interrupted"
    })
  })

  it("keeps a complete reset snapshot ahead of capped late-watcher replay", async () => {
    const adapter: CliAdapterShape = {
      run: (ownerId, spec, context) =>
        Effect.gen(function* () {
          if (ownerId.endsWith("agent-a")) {
            for (
              let index = 0;
              index < WORKER_ACTIVITY_REPLAY_CAP + 5;
              index++
            ) {
              yield* context.emit({
                _tag: "Assistant",
                text: `chunk:${index}`
              })
            }
          }
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      yield* service.execute(
        input([stage("01", "agent-a"), stage("02", "agent-b")])
      )
      return yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(Stream.take(WORKER_ACTIVITY_REPLAY_CAP + 1), Stream.runCollect)
    })

    const replay = [
      ...(await Effect.runPromise(
        program.pipe(Effect.provide(layerFor(adapter)))
      ))
    ]
    expect(replay).toHaveLength(WORKER_ACTIVITY_REPLAY_CAP + 1)
    expect(replay[0]).toMatchObject({
      _tag: "Reset",
      mode: "replace",
      workers: [
        { worker: { agentId: "agent-a" }, status: "completed" },
        { worker: { agentId: "agent-b" }, status: "completed" }
      ]
    })
  })

  it("bounds a stalled subscriber and rebuilds it from a fresh snapshot after a gap", async () => {
    const firstActivity = await Effect.runPromise(Deferred.make<void>())
    const releaseWatcher = await Effect.runPromise(Deferred.make<void>())
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) =>
        Effect.gen(function* () {
          for (let index = 0; index < WORKER_ACTIVITY_LIVE_CAP + 50; index++) {
            yield* context.emit({
              _tag: "Assistant",
              text: `live:${index}`
            })
          }
          yield* passCurrentStage(spec, context)
        }),
      stop: () => Effect.void
    }
    const program = Effect.gen(function* () {
      const service = yield* OrchestrationService
      let held = false
      const watcher = yield* service
        .watch("session-1", "plan-1", "chat-1")
        .pipe(
          Stream.tap(() => {
            if (held) return Effect.void
            held = true
            return Deferred.succeed(firstActivity, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseWatcher))
            )
          }),
          Stream.takeUntil(
            (activity) =>
              activity._tag === "State" &&
              activity.status === "completed"
          ),
          Stream.runCollect,
          Effect.fork
        )
      yield* Effect.yieldNow()
      const execution = yield* service
        .execute(input([stage("01", "agent-a")]))
        .pipe(Effect.fork)
      yield* Deferred.await(firstActivity)
      yield* Fiber.join(execution)
      yield* Deferred.succeed(releaseWatcher, undefined)
      return [...(yield* Fiber.join(watcher))]
    })

    const replayed = await Effect.runPromise(
      program.pipe(Effect.provide(layerFor(adapter)))
    )
    expect(
      replayed.filter((activity) => activity._tag === "Reset").length
    ).toBeGreaterThanOrEqual(2)
    expect(replayed.at(-1)).toMatchObject({
      _tag: "State",
      status: "completed"
    })
  })

  it("evicts inactive session feeds instead of caching them forever", async () => {
    const adapter: CliAdapterShape = {
      run: (_ownerId, spec, context) => passCurrentStage(spec, context),
      stop: () => Effect.void
    }
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* OrchestrationService
        for (
          let index = 0;
          index < WORKER_ACTIVITY_FEED_CAP + 3;
          index++
        ) {
          yield* service.execute(
            input([stage("01", "agent-a")], {
              sessionId: `session-${index}`,
              planId: `plan-${index}`
            })
          )
        }
        return yield* service.activityFeedCount()
      }).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(count).toBe(WORKER_ACTIVITY_FEED_CAP)
  })
})

describe("recoverOrchestrationCheckpoints", () => {
  it("marks only in-flight workers interrupted after a restart", () => {
    const recovered = recoverOrchestrationCheckpoints([
      {
        agentId: "agent-a",
        state: "running",
        completedStageIds: ["01"],
        resumeId: "resume-a",
        message: null,
        attempt: 1
      },
      {
        agentId: "agent-b",
        state: "completed",
        completedStageIds: ["02"],
        resumeId: "resume-b",
        message: null,
        attempt: 1
      }
    ])

    expect(recovered.map((checkpoint) => checkpoint.state)).toEqual([
      "interrupted",
      "completed"
    ])
    expect(recovered[0]?.completedStageIds).toEqual(["01"])
  })
})

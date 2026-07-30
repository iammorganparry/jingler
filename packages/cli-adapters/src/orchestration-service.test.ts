import { CliExecError } from "@jingler/core"
import type { CliKind } from "@jingler/core"
import { Effect, Fiber, Layer } from "effect"
import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { CliAdapter } from "./adapter.js"
import type { AgentContext, CliAdapterShape, SessionSpec } from "./adapter.js"
import {
  buildOrchestrationGroups,
  OrchestrationPersistenceError,
  OrchestrationService,
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
  markdown: [
    `<p>Implement ${id}</p>`,
    options.declaresFiles === false
      ? ""
      : `<ul data-files>${(options.files ?? []).map((file) => `<li>${file}</li>`).join("")}</ul>`
  ].join(""),
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

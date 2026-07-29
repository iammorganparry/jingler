import { CliExecError } from "@jingler/core"
import type { CliKind } from "@jingler/core"
import { Effect, Layer } from "effect"
import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import { CliAdapter } from "./adapter.js"
import type { CliAdapterShape, SessionSpec } from "./adapter.js"
import {
  buildOrchestrationGroups,
  OrchestrationService,
  orchestrationWorkerMachine,
  recoverOrchestrationCheckpoints
} from "./orchestration-service.js"
import type {
  OrchestrationAssignment,
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
  } = {}
): OrchestrationStage => ({
  id,
  title: `Stage ${id}`,
  intent: `Complete ${id}`,
  markdown: [
    `<p>Implement ${id}</p>`,
    options.files === undefined
      ? ""
      : `<ul data-files>${options.files.map((file) => `<li>${file}</li>`).join("")}</ul>`
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
          yield* context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
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
      new Set(["plan:plan-1:agent:agent-a", "plan:plan-1:agent:agent-b"])
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
      "plan:plan-1:agent:agent-a",
      "plan:plan-1:agent:agent-a"
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
                context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
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
          yield* context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
        })
      },
      stop: () => Effect.void
    }
    const serviceLayer = layerFor(adapter)
    const program = Effect.gen(function* () {
      const first = yield* OrchestrationService.execute(
        input([
          stage("01", "agent-a"),
          stage("02", "agent-a", { dependsOn: ["01"] })
        ])
      )
      const retried = yield* OrchestrationService.retryWorker({
        planId: "plan-1",
        agentId: "agent-a"
      })
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
        return context.emit({ _tag: "Done", costUsd: 0, tokens: 0 })
      },
      stop: () => Effect.void
    }

    await Effect.runPromise(
      OrchestrationService.execute(
        input([stage("01", "agent-a"), initialSecond], {
          refreshStage: (_agentId, stageId) =>
            Effect.succeed(stageId === "02" ? amendedSecond : null)
        })
      ).pipe(Effect.provide(layerFor(adapter)))
    )

    expect(prompts[1]).toContain(
      "Complete the user amendment with the existing worker"
    )
  })

  it("uses identical execution semantics for Claude, Codex, and OpenCode", async () => {
    const harnesses: ReadonlyArray<CliKind> = ["claude", "codex", "opencode"]
    const adapter: CliAdapterShape = {
      run: (_ownerId, _spec, context) =>
        context.emit({ _tag: "Done", costUsd: 0, tokens: 0 }),
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

import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { EventBus } from "@earendil-works/pi-coding-agent"
import {
  AgentEndpointId,
  CURRENT_RUNTIME_CONTRACTS,
  ProviderId,
  ProviderModelId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect, Stream } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  inactiveRuntimeActivity,
  type AgentRuntimeContext,
  type AgentRuntimeShape
} from "./agent-runtime.js"
import {
  isNativeExternalJobRuntime,
  makeNativeExternalJobProvider,
  registerNativeExternalJobProfiles
} from "./native-external-job-provider.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const stateRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-native-job-"))
  roots.push(root)
  return root
}

const spec = (runtimeId: "codex" | "opencode"): AgentRunSpec & {
  readonly runtimeId: "codex" | "opencode"
} => ({
  runId: `${runtimeId}-parent`,
  sessionId: "jingler-session",
  chatId: "chat-1",
  runtimeId,
  endpointId: AgentEndpointId.make(`desktop:${runtimeId}:default`),
  providerId: ProviderId.make(runtimeId === "codex" ? "openai" : "local"),
  modelId: ProviderModelId.make(`${runtimeId}/parent`),
  role: "conversation",
  mode: "auto",
  cwd: "/workspace",
  prompt: "parent",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  }
})

const context = (recordUsage = vi.fn(() => Effect.void)): AgentRuntimeContext => ({
  ...inactiveRuntimeActivity,
  recordUsage,
  canUseTool: () => Effect.succeed("allow"),
  askQuestion: () => Effect.succeed([])
})

const runtime = (seen: AgentRunSpec[], output = "native result"): AgentRuntimeShape => ({
  run: (child) => {
    seen.push(child)
    return Stream.make(
      { _tag: "Started" as const, sessionId: `${child.runtimeId}-session`, model: child.modelId },
      { _tag: "Assistant" as const, text: output },
      { _tag: "Done" as const, tokens: 17, costUsd: 0.42 }
    )
  },
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  controlSubagent: () => Effect.die("unused"),
  decidePlanReview: () => Effect.die("unused"),
  subagentFleetSnapshot: () => Effect.die("unused"),
  subagentTranscript: () => Effect.die("unused")
})

const startInput = (
  bindingId: string,
  modelId: string,
  sessionId = "pi-session"
) => ({
  prompt: "Inspect the implementation",
  promptDigest: "digest-1",
  cwd: "/workspace",
  runId: "async-run",
  stepIndex: 0,
  agent: "native-worker",
  options: { bindingId, role: "worker", modelId },
  sessionId
})

const terminalResult = async (
  provider: ReturnType<typeof makeNativeExternalJobProvider>["provider"],
  id: string
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polling must observe each durable state before retrying.
    const result = await provider.result(id)
    if (!["queued", "running"].includes(result.state)) return result
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("native external job did not settle")
}

describe("native external-job provider", () => {
  it.each(["codex", "opencode"] as const)(
    "routes %s profiles to assigned native models without nested delegation",
    async (runtimeId) => {
      const host = makeNativeExternalJobProvider(await stateRoot())
      const binding = host.bind({
        parentRuntimeSessionId: "pi-session",
        spec: spec(runtimeId),
        context: context(),
        models: { worker: ProviderModelId.make(`${runtimeId}/cheap`) },
        makeRuntime: () => runtime([])
      })
      const definitions: Array<{ name: string; definition: Record<string, unknown> }> = []
      const events = {
        on: () => () => undefined,
        emit: (_event: string, raw: unknown) => {
          const request = raw as {
            name: string
            definition: Record<string, unknown>
            result?: unknown
          }
          definitions.push({ name: request.name, definition: request.definition })
          request.result = { ok: true, registration: { dispose: vi.fn() } }
        }
      } as EventBus
      const profiles = registerNativeExternalJobProfiles(
        events,
        binding,
        { worker: ProviderModelId.make(`${runtimeId}/cheap`) },
        ProviderModelId.make(`${runtimeId}/parent`)
      )

      expect(Object.keys(profiles.names)).toEqual(expect.arrayContaining([
        "delegate", "fanout", "oracle", "researcher", "reviewer", "scout", "worker"
      ]))
      const worker = definitions.find((entry) => entry.name === profiles.names.worker)?.definition
      expect(worker).toMatchObject({
        allowNestedSubagents: false,
        runner: {
          type: "external-job",
          provider: "jingler-native",
          options: { bindingId: binding.bindingId, role: "worker", modelId: `${runtimeId}/cheap` }
        }
      })
      expect(isNativeExternalJobRuntime("claude")).toBe(false)
      profiles.dispose()
    }
  )

  it("disposes every external profile and the binding after one disposer throws", () => {
    const first = vi.fn(() => { throw new Error("first disposal failed") })
    const second = vi.fn()
    const disposeBinding = vi.fn()
    let registration = 0
    const events = {
      on: () => () => undefined,
      emit: (_event: string, raw: unknown) => {
        const request = raw as { result?: unknown }
        request.result = {
          ok: true,
          registration: { dispose: registration++ === 0 ? first : second }
        }
      }
    } as EventBus
    const profiles = registerNativeExternalJobProfiles(events, {
      bindingId: "binding-1",
      names: { worker: "worker-profile", reviewer: "reviewer-profile" },
      rebind: vi.fn(),
      dispose: disposeBinding
    }, {}, ProviderModelId.make("codex/parent"))

    expect(() => profiles.dispose()).toThrow("first disposal failed")
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(disposeBinding).toHaveBeenCalledOnce()
  })

  it.each(["codex", "opencode"] as const)(
    "persists terminal %s output, transcript, and attributable usage",
    async (runtimeId) => {
      const root = await stateRoot()
      const host = makeNativeExternalJobProvider(root)
      const seen: AgentRunSpec[] = []
      const recordUsage = vi.fn(() => Effect.void)
      const modelId = ProviderModelId.make(`${runtimeId}/cheap`)
      const binding = host.bind({
        parentRuntimeSessionId: "pi-session",
        spec: spec(runtimeId),
        context: context(recordUsage),
        models: { worker: modelId },
        makeRuntime: () => runtime(seen, `${runtimeId} terminal output`)
      })
      const started = await host.provider.start(startInput(binding.bindingId, modelId))
      const result = await terminalResult(host.provider, started.providerJobId)
      await host.provider.status(started.providerJobId)
      await host.provider.reattach(started.providerJobId)
      await host.provider.result(started.providerJobId)
      const persisted = JSON.parse(await readFile(join(root, `${started.providerJobId}.json`), "utf8"))
      const transcript = await readFile(join(root, `${started.providerJobId}.transcript.jsonl`), "utf8")

      expect(result).toMatchObject({ state: "completed", output: `${runtimeId} terminal output` })
      expect(seen[0]).toMatchObject({ runtimeId, modelId, prompt: "Inspect the implementation" })
      expect(persisted).toMatchObject({
        runtimeId,
        modelId,
        state: "completed",
        usage: {
          totalTokens: 17,
          costUsd: runtimeId === "opencode" ? 0.42 : null,
          provenance: `${runtimeId}.external-job`
        }
      })
      expect(transcript).toContain(`${runtimeId} terminal output`)
      expect(recordUsage).toHaveBeenCalledTimes(1)
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        runtimeId,
        modelId,
        totalTokens: 17,
        costUsd: runtimeId === "opencode" ? 0.42 : null,
        provenance: `${runtimeId}.external-job`
      }))
    }
  )

  it("rebinds later same-chat launches to the current parent turn", async () => {
    const host = makeNativeExternalJobProvider(await stateRoot())
    const seen: AgentRunSpec[] = []
    const recordUsage = vi.fn(() => Effect.void)
    const modelId = ProviderModelId.make("codex/cheap")
    const binding = host.bind({
      parentRuntimeSessionId: "pi-session",
      spec: spec("codex"),
      context: context(recordUsage),
      models: { worker: modelId },
      makeRuntime: () => runtime(seen)
    })
    binding.rebind({ ...spec("codex"), runId: "codex-current-parent" }, { worker: modelId })

    const started = await host.provider.start(startInput(binding.bindingId, modelId))
    await terminalResult(host.provider, started.providerJobId)

    expect(seen[0]?.runId).toContain("codex-current-parent:child:")
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "codex-current-parent"
    }))
  })

  it("continues follow-ups in the native conversation and reattaches without redispatch", async () => {
    const host = makeNativeExternalJobProvider(await stateRoot())
    const seen: AgentRunSpec[] = []
    const modelId = ProviderModelId.make("codex/cheap")
    const binding = host.bind({
      parentRuntimeSessionId: "pi-session",
      spec: spec("codex"),
      context: context(),
      models: { worker: modelId },
      makeRuntime: () => runtime(seen)
    })
    const first = await host.provider.start(startInput(binding.bindingId, modelId))
    await terminalResult(host.provider, first.providerJobId)
    await host.provider.reattach(first.providerJobId)
    expect(seen).toHaveLength(1)

    const followUp = await host.provider.followUp!({
      ...startInput(binding.bindingId, modelId),
      prompt: "Apply the review",
      promptDigest: "digest-2",
      sourceRunId: "async-run",
      sourceStepIndex: 0,
      parentProviderJobId: first.providerJobId,
      requestId: "follow-up-1",
      requestDigest: "follow-up-digest"
    })
    await terminalResult(host.provider, followUp.providerJobId)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      prompt: "Apply the review",
      continuation: { runtimeId: "codex", id: "codex-session" }
    })
  })

  it("isolates concurrent bindings by PI session and rejects cross-binding follow-up", async () => {
    const host = makeNativeExternalJobProvider(await stateRoot())
    const modelId = ProviderModelId.make("codex/cheap")
    const bind = (parentRuntimeSessionId: string) => host.bind({
      parentRuntimeSessionId,
      spec: spec("codex"),
      context: context(),
      models: { worker: modelId },
      makeRuntime: () => runtime([])
    })
    const first = bind("pi-a")
    const second = bind("pi-b")
    await expect(host.provider.start(startInput(first.bindingId, modelId, "pi-b")))
      .rejects.toMatchObject({ code: "binding-unavailable" })
    const parent = await host.provider.start(startInput(first.bindingId, modelId, "pi-a"))
    await terminalResult(host.provider, parent.providerJobId)
    await expect(host.provider.followUp!({
      ...startInput(second.bindingId, modelId, "pi-b"),
      sourceRunId: "async-run",
      sourceStepIndex: 0,
      parentProviderJobId: parent.providerJobId,
      requestId: "cross-binding",
      requestDigest: "cross-binding-digest"
    })).rejects.toMatchObject({ code: "binding-mismatch" })
  })

  it.each(["exception", "event"] as const)(
    "records one terminal error usage fact for a runtime %s",
    async (failureKind) => {
      const host = makeNativeExternalJobProvider(await stateRoot())
      const modelId = ProviderModelId.make("codex/cheap")
      const recordUsage = vi.fn(() => Effect.void)
      const failedRuntime: AgentRuntimeShape = {
        ...runtime([]),
        run: () => failureKind === "exception"
          ? Stream.die(new Error("runtime exploded"))
          : Stream.make({ _tag: "Failed" as const, message: "runtime refused" })
      }
      const binding = host.bind({
        parentRuntimeSessionId: "pi-session",
        spec: spec("codex"),
        context: context(recordUsage),
        models: { worker: modelId },
        makeRuntime: () => failedRuntime
      })

      const started = await host.provider.start(startInput(binding.bindingId, modelId))
      const result = await terminalResult(host.provider, started.providerJobId)

      expect(result).toMatchObject({ state: "failed", failureCode: "runtime-failed" })
      expect(recordUsage).toHaveBeenCalledTimes(1)
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "error",
        totalTokens: null,
        costUsd: null,
        provenance: "codex.external-job"
      }))
    }
  )

  it("settles durably when transcript persistence fails", async () => {
    const root = await stateRoot()
    const host = makeNativeExternalJobProvider(root)
    const modelId = ProviderModelId.make("codex/cheap")
    const recordUsage = vi.fn(() => Effect.void)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gatedRuntime: AgentRuntimeShape = {
      ...runtime([]),
      run: (child) => Stream.fromEffect(Effect.promise(() => gate)).pipe(
        Stream.flatMap(() => runtime([]).run(child, context()))
      )
    }
    const binding = host.bind({
      parentRuntimeSessionId: "pi-session",
      spec: spec("codex"),
      context: context(recordUsage),
      models: { worker: modelId },
      makeRuntime: () => gatedRuntime
    })

    const started = await host.provider.start(startInput(binding.bindingId, modelId))
    await writeFile(join(root, `${started.providerJobId}.transcript.jsonl`), "occupied\n")
    release()
    const result = await terminalResult(host.provider, started.providerJobId)

    expect(result).toMatchObject({ state: "failed", failureCode: "runtime-failed" })
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }))
  })

  it("fails durably without retrying a rejected usage write", async () => {
    const host = makeNativeExternalJobProvider(await stateRoot())
    const modelId = ProviderModelId.make("opencode/cheap")
    const recordUsage = vi.fn(() => Effect.die(new Error("usage unavailable")))
    const binding = host.bind({
      parentRuntimeSessionId: "pi-session",
      spec: spec("opencode"),
      context: context(recordUsage),
      models: { worker: modelId },
      makeRuntime: () => runtime([])
    })

    const started = await host.provider.start(startInput(binding.bindingId, modelId))
    await vi.waitFor(async () => {
      await expect(host.provider.result(started.providerJobId)).resolves.toMatchObject({
        state: "failed"
      })
    })

    expect(recordUsage).toHaveBeenCalledTimes(1)
  })

  it("aborts the underlying native stream when Fleet stops its async run", async () => {
    const host = makeNativeExternalJobProvider(await stateRoot())
    const modelId = ProviderModelId.make("codex/cheap")
    const recordUsage = vi.fn(() => Effect.void)
    const cancelled = vi.fn()
    const blockingRuntime: AgentRuntimeShape = {
      ...runtime([]),
      run: (child) => Stream.concat(
        Stream.make({
          _tag: "Started" as const,
          sessionId: `${child.runtimeId}-session`,
          model: child.modelId
        }),
        Stream.never
      ).pipe(Stream.ensuring(Effect.sync(cancelled)))
    }
    const binding = host.bind({
      parentRuntimeSessionId: "pi-session",
      spec: spec("codex"),
      context: context(recordUsage),
      models: { worker: modelId },
      makeRuntime: () => blockingRuntime
    })

    const started = await host.provider.start(startInput(binding.bindingId, modelId))
    await expect(host.stop("async-run", "another-pi-session")).resolves.toBe(0)
    expect(cancelled).not.toHaveBeenCalled()
    await expect(host.stop("async-run", "pi-session")).resolves.toBe(1)
    await expect(host.stop("async-run", "pi-session")).resolves.toBe(0)
    await expect(host.provider.result(started.providerJobId)).resolves.toMatchObject({
      state: "stopped",
      failureCode: "stopped"
    })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }))
  })

  it("never persists prompts, provider credentials, or capability tokens in job state", async () => {
    const root = await stateRoot()
    const host = makeNativeExternalJobProvider(root)
    const modelId = ProviderModelId.make("codex/cheap")
    const binding = host.bind({
      parentRuntimeSessionId: "pi-session",
      spec: spec("codex"),
      context: context(),
      models: { worker: modelId },
      makeRuntime: () => runtime([])
    })
    const secret = "sk-secret-provider-value"
    const capability = "capability-token-secret"
    const input = startInput(binding.bindingId, modelId)
    const started = await host.provider.start({
      ...input,
      prompt: `Inspect without persisting ${secret}`,
      options: { ...input.options, credential: secret, capabilityToken: capability }
    })
    await terminalResult(host.provider, started.providerJobId)

    const raw = await readFile(join(root, `${started.providerJobId}.json`), "utf8")
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain(capability)
    expect(raw).not.toContain("capabilityToken")
    expect(raw).not.toContain("credential")
  })

  it("fails closed for malformed and stale active durable state", async () => {
    const root = await stateRoot()
    const host = makeNativeExternalJobProvider(root)
    const malformedId = "11111111-1111-4111-8111-111111111111"
    await writeFile(join(root, `${malformedId}.json`), "{}\n")
    await expect(host.provider.reattach(malformedId)).rejects.toMatchObject({ code: "state-unreadable" })

    const tamperedId = "33333333-3333-4333-8333-333333333333"
    await writeFile(join(root, `${tamperedId}.json`), `${JSON.stringify({
      version: 1,
      providerJobId: "44444444-4444-4444-8444-444444444444",
      bindingId: "ended-binding",
      parentRuntimeSessionId: "pi-session",
      runtimeId: "codex",
      role: "worker",
      modelId: "codex/cheap",
      promptDigest: "digest",
      sourceRunId: "stale-run",
      startedAt: 1,
      updatedAt: 1,
      state: "completed"
    })}\n`)
    await expect(host.provider.result(tamperedId)).rejects.toMatchObject({
      code: "state-unreadable"
    })

    const staleId = "22222222-2222-4222-8222-222222222222"
    await writeFile(join(root, `${staleId}.json`), `${JSON.stringify({
      version: 1,
      providerJobId: staleId,
      bindingId: "ended-binding",
      parentRuntimeSessionId: "pi-session",
      runtimeId: "opencode",
      role: "worker",
      modelId: "opencode/cheap",
      promptDigest: "digest",
      sourceRunId: "stale-run",
      startedAt: 1,
      updatedAt: 1,
      state: "running"
    })}\n`)
    await expect(host.provider.reattach(staleId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "ambiguous-active-job"
    })
    const failedState = await readFile(join(root, `${staleId}.json`), "utf8")
    expect(JSON.parse(failedState)).toMatchObject({
      state: "failed",
      failureCode: "ambiguous-active-job"
    })
    await expect(host.provider.reattach(staleId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "ambiguous-active-job"
    })
    expect(await readFile(join(root, `${staleId}.json`), "utf8")).toBe(failedState)
  })

  it("retains malformed optional terminal fields instead of pruning them", async () => {
    const root = await stateRoot()
    const host = makeNativeExternalJobProvider(root)
    const now = Date.now()
    const old = now - 31 * 24 * 60 * 60_000
    const malformed: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { providerJobId: "" },
      { bindingId: "" },
      { parentRuntimeSessionId: "" },
      { role: "" },
      { modelId: "" },
      { promptDigest: "" },
      { sourceRunId: "" },
      { role: "x".repeat(4_097) },
      { startedAt: null },
      { updatedAt: "old" },
      { runtimeSessionId: 1 },
      { output: {} },
      { artifactPath: null },
      { failureCode: [] },
      { failureMessage: false },
      { endedAt: undefined },
      { endedAt: null },
      { usage: null },
      { usage: [] },
      { usage: { totalTokens: -1, costUsd: null, provenance: "codex.external-job" } },
      { usage: { totalTokens: 1, costUsd: -0.01, provenance: "codex.external-job" } },
      { usage: { totalTokens: 1, costUsd: null, provenance: "opencode.external-job" } }
    ]
    const ids = malformed.map((_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
    await Promise.all(malformed.map((fields, index) => writeFile(
      join(root, `${ids[index]}.json`),
      `${JSON.stringify({
        version: 1,
        providerJobId: ids[index],
        bindingId: "ended-binding",
        parentRuntimeSessionId: "pi-session",
        runtimeId: "codex",
        role: "worker",
        modelId: "codex/cheap",
        promptDigest: "digest",
        sourceRunId: "stale-run",
        startedAt: 1,
        updatedAt: old,
        endedAt: old,
        state: "completed",
        ...fields
      })}\n`
    )))

    await expect(host.recoverAndPrune(now)).resolves.toEqual({ failed: 0, pruned: 0 })
    await Promise.all(ids.map((id) =>
      expect(host.provider.result(id)).rejects.toMatchObject({ code: "state-unreadable" })
    ))
    await expect(readdir(root)).resolves.toHaveLength(ids.length)
  })

  it("recovers ambiguous jobs without dispatch or usage and prunes only old terminal pairs", async () => {
    const root = await stateRoot()
    const host = makeNativeExternalJobProvider(root)
    const now = Date.now()
    const activeId = "55555555-5555-4555-8555-555555555555"
    const terminalId = "66666666-6666-4666-8666-666666666666"
    const unreadableId = "77777777-7777-4777-8777-777777777777"
    const malformedTerminalId = "88888888-8888-4888-8888-888888888888"
    const record = (providerJobId: string, state: "running" | "completed", endedAt?: number) => ({
      version: 1,
      providerJobId,
      bindingId: "ended-binding",
      parentRuntimeSessionId: "pi-session",
      runtimeId: "codex",
      role: "worker",
      modelId: "codex/cheap",
      promptDigest: "digest",
      sourceRunId: "stale-run",
      startedAt: 1,
      updatedAt: endedAt ?? 1,
      ...(endedAt === undefined ? {} : { endedAt }),
      state
    })
    await writeFile(join(root, `${activeId}.json`), `${JSON.stringify(record(activeId, "running"))}\n`)
    await writeFile(join(root, `${terminalId}.json`), `${JSON.stringify(record(
      terminalId,
      "completed",
      now - 31 * 24 * 60 * 60_000
    ))}\n`)
    await writeFile(join(root, `${terminalId}.transcript.jsonl`), "terminal\n")
    await writeFile(join(root, `${unreadableId}.json`), "{}\n")
    await writeFile(join(root, `${malformedTerminalId}.json`), `${JSON.stringify({
      ...record(malformedTerminalId, "completed"),
      updatedAt: Number.POSITIVE_INFINITY
    })}\n`)
    const staleNext = join(root, "orphan.next")
    await writeFile(staleNext, "partial")
    const old = new Date(now - 31 * 24 * 60 * 60_000)
    await utimes(staleNext, old, old)

    await expect(host.recoverAndPrune(now)).resolves.toEqual({ failed: 1, pruned: 2 })
    await expect(host.provider.reattach(activeId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "ambiguous-active-job"
    })
    await expect(host.provider.reattach(malformedTerminalId)).rejects.toMatchObject({
      code: "state-unreadable"
    })
    await expect(readdir(root)).resolves.toEqual(expect.arrayContaining([
      `${activeId}.json`,
      `${unreadableId}.json`,
      `${malformedTerminalId}.json`
    ]))
    expect((await readdir(root))).not.toEqual(expect.arrayContaining([
      `${terminalId}.json`,
      `${terminalId}.transcript.jsonl`,
      "orphan.next"
    ]))
  })
})

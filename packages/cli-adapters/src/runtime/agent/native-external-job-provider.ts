import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  JINGLER_SUBAGENT_NAMES,
  makeUsageFact,
  type AgentRunSpec,
  type JinglerSubagentName,
  type ProviderModelId,
  type StreamEvent,
  type SubagentModelAssignments
} from "@jingler/core"
import { Chunk, Effect, Stream } from "effect"
import type { EventBus } from "@earendil-works/pi-coding-agent"
import { registerAgentViaEvents } from "pi-subagents/agents"
import {
  ExternalJobProviderError,
  registerExternalJobProvider,
  type ExternalJobFollowUpInput,
  type ExternalJobHandle,
  type ExternalJobProvider,
  type ExternalJobResult,
  type ExternalJobStartInput,
  type ExternalJobState
} from "pi-subagents/external-job-provider"
import type { AgentRuntimeContext, AgentRuntimeShape } from "./agent-runtime.js"
import { directNativeChildSpec } from "./direct-native-subagent.js"

export const JINGLER_NATIVE_EXTERNAL_JOB_PROVIDER = "jingler-native"
const MAX_TRANSCRIPT_CHARS = 128_000
const MAX_ID_CHARS = 4_096
const MAX_PATH_CHARS = 16_384
const MAX_FAILURE_CODE_CHARS = 128
const MAX_FAILURE_MESSAGE_CHARS = 4_096
const NATIVE_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000
const PROVIDER_JOB_ID = /^[a-f0-9-]{36}$/u
const PROVIDER_JOB_RECORD = /^([a-f0-9-]{36})\.json$/u

export const isNativeExternalJobRuntime = (
  runtimeId: AgentRunSpec["runtimeId"]
): runtimeId is "codex" | "opencode" => runtimeId === "codex" || runtimeId === "opencode"

export interface NativeExternalJobBinding {
  readonly parentPiSessionId: string
  readonly spec: AgentRunSpec & { readonly runtimeId: "codex" | "opencode" }
  readonly context: AgentRuntimeContext
  readonly models: SubagentModelAssignments
  readonly makeRuntime: (runtimeId: "codex" | "opencode") => AgentRuntimeShape
}

interface NativeExternalJobRecord {
  readonly version: 1
  readonly providerJobId: string
  readonly bindingId: string
  readonly parentPiSessionId: string
  readonly runtimeId: "codex" | "opencode"
  readonly role: string
  readonly modelId: string
  readonly promptDigest: string
  readonly sourceRunId: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly endedAt?: number
  readonly runtimeSessionId?: string
  readonly state: ExternalJobState
  readonly output?: string
  readonly artifactPath?: string
  readonly usage?: {
    readonly totalTokens: number | null
    readonly costUsd: number | null
    readonly provenance: "codex.external-job" | "opencode.external-job"
  }
  readonly failureCode?: string
  readonly failureMessage?: string
}

export interface NativeExternalJobProfileSet {
  readonly bindingId: string
  readonly names: Readonly<Record<string, string>>
  rebind(spec: NativeExternalJobBinding["spec"], models: SubagentModelAssignments): void
  dispose(): void
}

const disposeAll = (actions: ReadonlyArray<() => void>): void => {
  let firstFailure: unknown
  for (const dispose of actions) {
    try {
      dispose()
    } catch (cause) {
      firstFailure ??= cause
    }
  }
  if (firstFailure !== undefined) throw firstFailure
}

export const registerNativeExternalJobProfiles = (
  events: EventBus,
  profiles: NativeExternalJobProfileSet,
  models: SubagentModelAssignments,
  fallbackModel: ProviderModelId
): NativeExternalJobProfileSet => {
  const registrations: Array<{ dispose(): void }> = []
  try {
    for (const [role, name] of Object.entries(profiles.names)) {
      registrations.push(registerAgentViaEvents({
        pi: { events },
        name,
        definition: {
          description: `Jingler-owned native ${role} leaf`,
          systemPrompt: "Execute the supplied task and return a concise result.",
          tools: [],
          allowNestedSubagents: false,
          inheritProjectContext: false,
          inheritGlobalContext: false,
          inheritSkills: false,
          runner: {
            type: "external-job",
            provider: JINGLER_NATIVE_EXTERNAL_JOB_PROVIDER,
            options: {
              bindingId: profiles.bindingId,
              role,
              modelId: String(models[role as keyof SubagentModelAssignments] ?? fallbackModel)
            }
          }
        }
      }))
    }
  } catch (cause) {
    try {
      disposeAll([...registrations.map((registration) => () => registration.dispose()), profiles.dispose])
    } catch {
      // Registration failure remains the primary error.
    }
    throw cause
  }
  return {
    ...profiles,
    dispose: () => disposeAll([
      ...registrations.map((registration) => () => registration.dispose()),
      profiles.dispose
    ])
  }
}

export interface NativeExternalJobProviderHost {
  readonly provider: ExternalJobProvider
  bind(input: NativeExternalJobBinding): NativeExternalJobProfileSet
  stop(sourceRunId: string, parentPiSessionId?: string): Promise<number>
  recoverAndPrune(now?: number): Promise<{ readonly failed: number; readonly pruned: number }>
}

const optionsFor = (input: ExternalJobStartInput): {
  bindingId: string
  role: JinglerSubagentName
  modelId: string
} => {
  const { bindingId, role, modelId } = input.options
  if (
    typeof bindingId !== "string" || bindingId.length === 0 ||
    typeof role !== "string" || !JINGLER_SUBAGENT_NAMES.includes(role as JinglerSubagentName) ||
    typeof modelId !== "string" || modelId.length === 0
  ) {
    throw new ExternalJobProviderError("Malformed Jingler native external-job options", {
      code: "invalid-options"
    })
  }
  return { bindingId, role: role as JinglerSubagentName, modelId }
}

const boundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength

const optionalText = (value: unknown, maxLength: number): value is string | undefined =>
  value === undefined || (typeof value === "string" && value.length <= maxLength)

const optionalFinite = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === "number" && Number.isFinite(value))

const nullableNonnegative = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)

const validUsage = (
  value: unknown,
  runtimeId: NativeExternalJobRecord["runtimeId"]
): value is NonNullable<NativeExternalJobRecord["usage"]> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  return nullableNonnegative(usage.totalTokens) &&
    nullableNonnegative(usage.costUsd) &&
    usage.provenance === `${runtimeId}.external-job`
}

const safeRecord = (value: unknown): NativeExternalJobRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalJobProviderError("Malformed Jingler native external-job state", {
      code: "state-unreadable"
    })
  }
  const candidate = value as Partial<NativeExternalJobRecord>
  const terminal = candidate.state === "completed" ||
    candidate.state === "failed" ||
    candidate.state === "stopped" ||
    candidate.state === "blocked"
  if (
    candidate.version !== 1 ||
    !boundedText(candidate.providerJobId, MAX_ID_CHARS) ||
    !PROVIDER_JOB_ID.test(candidate.providerJobId) ||
    !boundedText(candidate.bindingId, MAX_ID_CHARS) ||
    (candidate.runtimeId !== "codex" && candidate.runtimeId !== "opencode") ||
    !boundedText(candidate.parentPiSessionId, MAX_ID_CHARS) ||
    !boundedText(candidate.role, MAX_ID_CHARS) ||
    !boundedText(candidate.modelId, MAX_ID_CHARS) ||
    !boundedText(candidate.promptDigest, MAX_ID_CHARS) ||
    !boundedText(candidate.sourceRunId, MAX_ID_CHARS) ||
    typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt) ||
    typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt) ||
    !optionalFinite(candidate.endedAt) ||
    !optionalText(candidate.runtimeSessionId, MAX_ID_CHARS) ||
    !optionalText(candidate.output, MAX_TRANSCRIPT_CHARS) ||
    !optionalText(candidate.artifactPath, MAX_PATH_CHARS) ||
    !optionalText(candidate.failureCode, MAX_FAILURE_CODE_CHARS) ||
    !optionalText(candidate.failureMessage, MAX_FAILURE_MESSAGE_CHARS) ||
    (candidate.usage !== undefined && !validUsage(candidate.usage, candidate.runtimeId)) ||
    (terminal && candidate.endedAt === undefined) ||
    !["queued", "running", "completed", "failed", "stopped", "blocked"].includes(candidate.state ?? "")
  ) {
    throw new ExternalJobProviderError("Malformed Jingler native external-job state", {
      code: "state-unreadable"
    })
  }
  return candidate as NativeExternalJobRecord
}

const toHandle = (record: NativeExternalJobRecord): ExternalJobHandle => ({
  providerJobId: record.providerJobId,
  state: record.state,
  ...(record.failureCode ? { failureCode: record.failureCode } : {}),
  ...(record.failureMessage ? { failureMessage: record.failureMessage } : {})
})

export const makeNativeExternalJobProvider = (
  stateRoot: string
): NativeExternalJobProviderHost => {
  const root = resolve(stateRoot)
  const bindings = new Map<string, NativeExternalJobBinding>()
  const active = new Map<string, {
    readonly sourceRunId: string
    readonly parentPiSessionId: string
    readonly controller: AbortController
    readonly settled: Promise<void>
  }>()
  const recordPath = (id: string) => join(root, `${id}.json`)
  const transcriptPath = (id: string) => join(root, `${id}.transcript.jsonl`)

  const persist = async (record: NativeExternalJobRecord): Promise<void> => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const target = recordPath(record.providerJobId)
    const temporary = `${target}.${process.pid}.${randomUUID()}.next`
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" })
      await rename(temporary, target)
    } catch (cause) {
      await rm(temporary, { force: true })
      throw cause
    }
  }

  const read = async (id: string): Promise<NativeExternalJobRecord> => {
    if (!PROVIDER_JOB_ID.test(id)) {
      throw new ExternalJobProviderError("Unknown Jingler native external job", { code: "not-found" })
    }
    try {
      const record = safeRecord(JSON.parse(await readFile(recordPath(id), "utf8")))
      if (record.providerJobId !== id) {
        throw new ExternalJobProviderError("Jingler native external-job identity does not match its state file", {
          code: "state-unreadable"
        })
      }
      return record
    } catch (cause) {
      if (cause instanceof ExternalJobProviderError) throw cause
      throw new ExternalJobProviderError("Jingler native external-job state is missing or unreadable", {
        code: "state-unreadable",
        cause
      })
    }
  }

  const failAmbiguous = async (record: NativeExternalJobRecord): Promise<NativeExternalJobRecord> => {
    if (record.state !== "queued" && record.state !== "running") return record
    if (active.has(record.providerJobId)) return record
    const failed: NativeExternalJobRecord = {
      ...record,
      state: "failed",
      updatedAt: Date.now(),
      endedAt: Date.now(),
      failureCode: "ambiguous-active-job",
      failureMessage: "The native job is no longer provably active; refusing to redispatch it."
    }
    await persist(failed)
    return failed
  }

  const execute = async (
    record: NativeExternalJobRecord,
    binding: NativeExternalJobBinding,
    prompt: string,
    signal: AbortSignal,
    continuationId?: string
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one lifecycle must settle persistence and usage exactly once.
  ): Promise<void> => {
    const child = directNativeChildSpec(
      binding.spec,
      record.role,
      prompt,
      record.modelId as ProviderModelId
    )
    const childSpec: AgentRunSpec = continuationId === undefined
      ? child
      : {
          ...child,
          continuation: {
            runtimeId: child.runtimeId,
            endpointId: child.endpointId,
            id: continuationId
          }
        }
    let current: NativeExternalJobRecord = {
      ...record,
      state: "running",
      updatedAt: Date.now()
    }
    let usageAttempted = false
    const recordTerminalUsage = async (
      outcome: "success" | "error" | "cancelled",
      done?: Extract<StreamEvent, { readonly _tag: "Done" }>
    ): Promise<void> => {
      usageAttempted = true
      const costUsd = outcome === "success" && binding.spec.runtimeId === "opencode"
        ? (done?.costUsd ?? null)
        : null
      await Effect.runPromise(binding.context.recordUsage?.(makeUsageFact({
        id: `${binding.spec.runId}:external-job:${record.providerJobId}`,
        runId: childSpec.runId,
        sessionId: binding.spec.sessionId,
        chatId: binding.spec.chatId,
        parentRunId: binding.spec.runId,
        runtimeId: binding.spec.runtimeId,
        providerId: binding.spec.providerId ?? null,
        modelId: record.modelId,
        kind: "child",
        startedAt: record.startedAt,
        endedAt: Date.now(),
        totalTokens: outcome === "success" ? (done?.tokens ?? null) : null,
        costUsd,
        outcome,
        provenance: `${binding.spec.runtimeId}.external-job`
      })) ?? Effect.void)
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: terminal cancellation and failure share one exactly-once persistence boundary.
    const settleFailed = async (cause: unknown): Promise<void> => {
      const endedAt = Date.now()
      const stopped = signal.aborted
      current = {
        ...current,
        state: stopped ? "stopped" : "failed",
        updatedAt: endedAt,
        endedAt,
        failureCode: stopped ? "stopped" : "runtime-failed",
        failureMessage: stopped
          ? "The native job was stopped by the operator."
          : cause instanceof Error ? cause.message : String(cause),
        usage: {
          totalTokens: null,
          costUsd: null,
          provenance: `${binding.spec.runtimeId}.external-job`
        }
      }
      try {
        await persist(current)
      } catch {
        // The queued record remains recoverable when the terminal write itself fails.
      }
      if (!usageAttempted) {
        try {
          await recordTerminalUsage(stopped ? "cancelled" : "error")
        } catch {
          // Usage attribution is attempted once; retrying could double-count a partial write.
        }
      }
    }

    try {
      await persist(current)
      const events = Chunk.toReadonlyArray(await Effect.runPromise(
        binding.makeRuntime(binding.spec.runtimeId).run(childSpec, binding.context).pipe(Stream.runCollect),
        { signal }
      ))
      const started = events.find((event) => event._tag === "Started")
      const failure = events.find((event) => event._tag === "Failed")
      const done = events.findLast((event) => event._tag === "Done")
      const output = events.flatMap((event) => event._tag === "Assistant" ? [event.text] : [])
        .join("").slice(-MAX_TRANSCRIPT_CHARS)
      const transcript = events.map((event) => JSON.stringify(
        event._tag === "Assistant"
          ? { tag: event._tag, text: event.text.slice(0, MAX_TRANSCRIPT_CHARS) }
          : { tag: event._tag }
      )).join("\n").slice(-MAX_TRANSCRIPT_CHARS)
      await writeFile(transcriptPath(record.providerJobId), `${transcript}\n`, {
        mode: 0o600,
        flag: "wx"
      })
      const runtimeSessionId = started?._tag === "Started" ? started.sessionId : undefined
      if (failure?._tag === "Failed" || done?._tag !== "Done") {
        const endedAt = Date.now()
        current = {
          ...current,
          ...(runtimeSessionId ? { runtimeSessionId } : {}),
          state: "failed",
          output,
          artifactPath: transcriptPath(record.providerJobId),
          usage: {
            totalTokens: null,
            costUsd: null,
            provenance: `${binding.spec.runtimeId}.external-job`
          },
          updatedAt: endedAt,
          endedAt,
          failureCode: "runtime-failed",
          failureMessage: failure?._tag === "Failed"
            ? failure.message
            : "Native runtime ended without usage"
        }
        await persist(current)
        await recordTerminalUsage("error")
        return
      }
      const usage: NonNullable<NativeExternalJobRecord["usage"]> = {
        totalTokens: done.tokens,
        costUsd: binding.spec.runtimeId === "opencode" ? done.costUsd : null,
        provenance: `${binding.spec.runtimeId}.external-job`
      }
      const endedAt = Date.now()
      current = {
        ...current,
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
        state: "completed",
        output,
        artifactPath: transcriptPath(record.providerJobId),
        usage,
        updatedAt: endedAt,
        endedAt
      }
      await persist(current)
      await recordTerminalUsage("success", done)
    } catch (cause) {
      await settleFailed(cause)
    }
  }

  const launch = async (
    input: ExternalJobStartInput,
    continuationId?: string
  ): Promise<ExternalJobHandle> => {
    const options = optionsFor(input)
    const binding = bindings.get(options.bindingId)
    if (!binding || input.sessionId !== binding.parentPiSessionId) {
      throw new ExternalJobProviderError("Native delegation binding is missing or belongs to another PI session", {
        code: "binding-unavailable"
      })
    }
    const expectedModel = String(binding.models[options.role as keyof SubagentModelAssignments] ?? binding.spec.modelId)
    if (options.modelId !== expectedModel) {
      throw new ExternalJobProviderError("Native delegation model no longer matches its binding", {
        code: "binding-mismatch"
      })
    }
    const providerJobId = randomUUID()
    const now = Date.now()
    const record: NativeExternalJobRecord = {
      version: 1,
      providerJobId,
      bindingId: options.bindingId,
      parentPiSessionId: binding.parentPiSessionId,
      runtimeId: binding.spec.runtimeId,
      role: options.role,
      modelId: options.modelId,
      promptDigest: input.promptDigest,
      sourceRunId: input.runId,
      startedAt: now,
      updatedAt: now,
      state: "queued"
    }
    await persist(record)
    const controller = new AbortController()
    const settled = execute(record, binding, input.prompt, controller.signal, continuationId)
      .catch(() => undefined)
      .finally(() => active.delete(providerJobId))
    active.set(providerJobId, {
      sourceRunId: input.runId,
      parentPiSessionId: binding.parentPiSessionId,
      controller,
      settled
    })
    return { providerJobId, state: "running" }
  }

  const provider: ExternalJobProvider = {
    name: JINGLER_NATIVE_EXTERNAL_JOB_PROVIDER,
    start: launch,
    followUp: async (input: ExternalJobFollowUpInput) => {
      const parent = await read(input.parentProviderJobId)
      const options = optionsFor(input)
      if (options.bindingId !== parent.bindingId) {
        throw new ExternalJobProviderError("The follow-up binding does not own the native parent job", {
          code: "binding-mismatch"
        })
      }
      if (parent.state !== "completed" || !parent.runtimeSessionId) {
        throw new ExternalJobProviderError("The native parent conversation is unavailable", {
          code: "parent-conversation-unavailable"
        })
      }
      return launch(input, parent.runtimeSessionId)
    },
    status: async (id) => toHandle(await failAmbiguous(await read(id))),
    reattach: async (id) => toHandle(await failAmbiguous(await read(id))),
    result: async (id): Promise<ExternalJobResult> => {
      const record = await failAmbiguous(await read(id))
      return {
        ...toHandle(record),
        ...(record.output ? { output: record.output } : {}),
        ...(record.artifactPath ? { artifactPath: record.artifactPath } : {})
      }
    }
  }

  const pruneStaleNext = async (name: string, cutoff: number): Promise<number> => {
    if (!name.endsWith(".next")) return 0
    try {
      if ((await stat(join(root, name))).mtimeMs >= cutoff) return 0
      await rm(join(root, name), { force: true })
      return 1
    } catch {
      // Concurrent cleanup is harmless.
      return 0
    }
  }

  const recoverRecord = async (
    name: string,
    cutoff: number
  ): Promise<{ readonly failed: number; readonly pruned: number }> => {
    const id = PROVIDER_JOB_RECORD.exec(name)?.[1]
    if (id === undefined) return { failed: 0, pruned: 0 }
    let record: NativeExternalJobRecord
    try {
      record = await read(id)
    } catch {
      // Unreadable state is retained so recovery fails closed without data loss.
      return { failed: 0, pruned: 0 }
    }
    const recovered = await failAmbiguous(record)
    const failed = recovered === record ? 0 : 1
    if (
      recovered.endedAt === undefined ||
      recovered.endedAt >= cutoff ||
      recovered.state === "queued" ||
      recovered.state === "running"
    ) return { failed, pruned: 0 }
    await Promise.all([
      rm(recordPath(id), { force: true }),
      rm(transcriptPath(id), { force: true })
    ])
    return { failed, pruned: 1 }
  }

  const recoverAndPrune = async (
    now = Date.now()
  ): Promise<{ readonly failed: number; readonly pruned: number }> => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const cutoff = now - NATIVE_JOB_RETENTION_MS
    const results = await Promise.all((await readdir(root)).map(async (name) => {
      const staleNext = await pruneStaleNext(name, cutoff)
      return staleNext > 0
        ? { failed: 0, pruned: staleNext }
        : recoverRecord(name, cutoff)
    }))
    return results.reduce((total, result) => ({
      failed: total.failed + result.failed,
      pruned: total.pruned + result.pruned
    }), { failed: 0, pruned: 0 })
  }

  return {
    provider,
    recoverAndPrune,
    stop: async (sourceRunId, parentPiSessionId) => {
      const matches = [...active.values()].filter((entry) =>
        entry.sourceRunId === sourceRunId &&
        (parentPiSessionId === undefined || entry.parentPiSessionId === parentPiSessionId)
      )
      for (const entry of matches) entry.controller.abort(new Error("Stopped by operator"))
      await Promise.all(matches.map((entry) => entry.settled))
      return matches.length
    },
    bind: (binding) => {
      const bindingId = randomUUID()
      bindings.set(bindingId, binding)
      const names = Object.fromEntries(
        JINGLER_SUBAGENT_NAMES.map((role) => [
          role,
          `jingler-${binding.spec.runtimeId}-${bindingId}-${role}`
        ])
      )
      return {
        bindingId,
        names,
        rebind: (spec, models) => {
          const current = bindings.get(bindingId)
          if (current !== undefined) bindings.set(bindingId, { ...current, spec, models })
        },
        dispose: () => { bindings.delete(bindingId) }
      }
    }
  }
}

let installed: { root: string; host: NativeExternalJobProviderHost } | undefined

export const ensureNativeExternalJobProvider = (
  stateRoot: string
): NativeExternalJobProviderHost => {
  const root = resolve(stateRoot)
  if (installed) {
    if (installed.root !== root) throw new Error("Jingler native external-job provider already uses another state root")
    return installed.host
  }
  const host = makeNativeExternalJobProvider(root)
  registerExternalJobProvider(host.provider)
  installed = { root, host }
  return host
}

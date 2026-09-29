import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
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
const PROVIDER_JOB_ID = /^[a-f0-9-]{36}$/u

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
  dispose(): void
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
    for (const registration of registrations) registration.dispose()
    profiles.dispose()
    throw cause
  }
  return {
    ...profiles,
    dispose: () => {
      for (const registration of registrations) registration.dispose()
      profiles.dispose()
    }
  }
}

export interface NativeExternalJobProviderHost {
  readonly provider: ExternalJobProvider
  bind(input: NativeExternalJobBinding): NativeExternalJobProfileSet
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

const safeRecord = (value: unknown): NativeExternalJobRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalJobProviderError("Malformed Jingler native external-job state", {
      code: "state-unreadable"
    })
  }
  const candidate = value as Partial<NativeExternalJobRecord>
  if (
    candidate.version !== 1 ||
    typeof candidate.providerJobId !== "string" ||
    typeof candidate.bindingId !== "string" ||
    (candidate.runtimeId !== "codex" && candidate.runtimeId !== "opencode") ||
    typeof candidate.parentPiSessionId !== "string" ||
    typeof candidate.role !== "string" ||
    typeof candidate.modelId !== "string" ||
    typeof candidate.promptDigest !== "string" ||
    typeof candidate.startedAt !== "number" ||
    typeof candidate.updatedAt !== "number" ||
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
  const active = new Map<string, Promise<void>>()
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
      return safeRecord(JSON.parse(await readFile(recordPath(id), "utf8")))
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
    continuationId?: string
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: native execution, terminal persistence, and usage attribution settle in one auditable lifecycle.
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
    await persist(current)
    let events: ReadonlyArray<StreamEvent>
    try {
      events = Chunk.toReadonlyArray(await Effect.runPromise(
        binding.makeRuntime(binding.spec.runtimeId).run(childSpec, binding.context).pipe(Stream.runCollect)
      ))
    } catch (cause) {
      current = {
        ...current,
        state: "failed",
        updatedAt: Date.now(),
        endedAt: Date.now(),
        failureCode: "runtime-failed",
        failureMessage: cause instanceof Error ? cause.message : String(cause)
      }
      await persist(current)
      return
    }
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
      current = {
        ...current,
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
        state: "failed",
        output,
        updatedAt: Date.now(),
        endedAt: Date.now(),
        failureCode: "runtime-failed",
        failureMessage: failure?._tag === "Failed" ? failure.message : "Native runtime ended without usage"
      }
      await persist(current)
      return
    }
    const usage: NonNullable<NativeExternalJobRecord["usage"]> = {
      totalTokens: done.tokens,
      costUsd: binding.spec.runtimeId === "opencode" ? done.costUsd : null,
      provenance: `${binding.spec.runtimeId}.external-job`
    }
    current = {
      ...current,
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
      state: "completed",
      output,
      artifactPath: transcriptPath(record.providerJobId),
      usage,
      updatedAt: Date.now(),
      endedAt: Date.now()
    }
    await persist(current)
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
      endedAt: current.endedAt!,
      totalTokens: done.tokens,
      costUsd: usage.costUsd,
      outcome: "success",
      provenance: usage.provenance
    })) ?? Effect.void)
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
      startedAt: now,
      updatedAt: now,
      state: "queued"
    }
    await persist(record)
    const running = execute(record, binding, input.prompt, continuationId)
      .finally(() => active.delete(providerJobId))
    active.set(providerJobId, running)
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

  return {
    provider,
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

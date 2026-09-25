import {
  AgentEndpointId,
  AgentRuntimeId,
  piEndpointId,
  RuntimeContinuation,
  type ProviderConnectionId,
  type ProviderId,
  type ProviderModelId
} from "@jingler/core"
import { Schema } from "effect"

const LegacyChatObject = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  resumeId: Schema.optional(Schema.Unknown),
  runtimeId: Schema.optional(Schema.Unknown),
  endpointId: Schema.optional(Schema.Unknown),
  connectionId: Schema.optional(Schema.Unknown),
  providerId: Schema.optional(Schema.Unknown),
  modelId: Schema.optional(Schema.Unknown),
  continuation: Schema.optional(Schema.Unknown),
  piSessionId: Schema.optional(Schema.Unknown),
  legacyModel: Schema.optional(Schema.Unknown),
  legacyResumeId: Schema.optional(Schema.Unknown)
})
const LegacyChatWithId = Schema.Struct({ id: Schema.Unknown })
const LegacySessionObject = Schema.Struct({
  chats: Schema.optional(Schema.Unknown),
  activeChatId: Schema.optional(Schema.Unknown),
  environmentId: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  resumeId: Schema.optional(Schema.Unknown),
  cli: Schema.optional(Schema.Unknown),
  runtimeId: Schema.optional(Schema.Unknown),
  endpointId: Schema.optional(Schema.Unknown),
  connectionId: Schema.optional(Schema.Unknown),
  providerId: Schema.optional(Schema.Unknown),
  modelId: Schema.optional(Schema.Unknown),
  continuation: Schema.optional(Schema.Unknown),
  piSessionId: Schema.optional(Schema.Unknown)
})
const LegacyConfigObject = Schema.Struct({
  defaultConnectionId: Schema.optional(Schema.Unknown),
  defaultCli: Schema.optional(Schema.Unknown),
  providers: Schema.optional(Schema.Unknown)
})
const LegacyProviderMap = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const LegacyProviderSettings = Schema.Struct({ defaultModel: Schema.optional(Schema.Unknown) })

export interface LegacyRuntimeCandidate {
  readonly providerId: string | null
  readonly model: string | null
  readonly cli: string | null
}

export interface ResolvedRuntimeIdentity {
  readonly connectionId: ProviderConnectionId
  readonly providerId: ProviderId
  readonly modelId: ProviderModelId
}

export type LegacyRuntimeResolver = (
  candidate: LegacyRuntimeCandidate
) => ResolvedRuntimeIdentity | null

export const providerFromLegacy = (
  cli: unknown,
  model: unknown
): string | null => {
  if (cli === "claude") return "anthropic"
  if (cli === "codex") return "openai-codex"
  if (cli === "opencode" && typeof model === "string" && model.includes("/")) {
    return model.slice(0, model.indexOf("/")) || null
  }
  return null
}

type ExistingRuntime = Pick<typeof LegacyChatObject.Type, "connectionId" | "providerId" | "modelId">

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const resolvedFields = (
  existing: ExistingRuntime,
  resolved: ResolvedRuntimeIdentity | null,
  providerId: string | null
) => ({
  ...(existing.connectionId === undefined && resolved
    ? { connectionId: resolved.connectionId }
    : {}),
  ...(existing.providerId === undefined && (resolved?.providerId ?? providerId)
    ? { providerId: resolved?.providerId ?? providerId }
    : {}),
  ...(existing.modelId === undefined && resolved ? { modelId: resolved.modelId } : {})
})

const preservedRuntimeFields = (existing: ExistingRuntime) => ({
  ...(existing.connectionId === undefined ? {} : { connectionId: existing.connectionId }),
  ...(existing.providerId === undefined ? {} : { providerId: existing.providerId }),
  ...(existing.modelId === undefined ? {} : { modelId: existing.modelId })
})

const legacyHistory = (legacyModel: string | null, legacyResumeId: string | null) => ({
  ...(legacyModel === null ? {} : { legacyModel }),
  ...(legacyResumeId === null ? {} : { legacyResumeId })
})

const resolveLegacyCandidate = (
  cli: unknown,
  model: string | null,
  resolve?: LegacyRuntimeResolver
) => {
  const providerId = providerFromLegacy(cli, model)
  const resolved = resolve?.({ providerId, model, cli: stringOrNull(cli) }) ?? null
  return { providerId, resolved }
}

const endpointFor = (
  endpoint: unknown,
  connection: unknown,
  resolved: ResolvedRuntimeIdentity | null,
  targetId: string
): AgentEndpointId | undefined => {
  if (typeof endpoint === "string" && endpoint.length > 0) return AgentEndpointId.make(endpoint)
  const connectionId = typeof connection === "string"
    ? connection as ProviderConnectionId
    : resolved?.connectionId
  return connectionId === undefined ? undefined : piEndpointId(targetId, connectionId)
}

const continuationFor = (
  continuation: unknown,
  legacyPiSessionId: unknown,
  endpointId: AgentEndpointId | undefined
): RuntimeContinuation | undefined => {
  if (Schema.is(RuntimeContinuation)(continuation)) return continuation
  const id = stringOrNull(continuation) ?? stringOrNull(legacyPiSessionId)
  return id === null || endpointId === undefined
    ? undefined
    : { runtimeId: "pi", endpointId, id }
}

const migrateChat = (
  chat: unknown,
  legacyCli: unknown,
  targetId: string,
  resolve?: LegacyRuntimeResolver
): unknown => {
  if (!Schema.is(LegacyChatObject)(chat)) return chat
  const legacyModel = stringOrNull(chat.model)
  const legacyResumeId = stringOrNull(chat.resumeId)
  const { providerId, resolved } = resolveLegacyCandidate(legacyCli, legacyModel, resolve)
  const endpointId = endpointFor(chat.endpointId, chat.connectionId, resolved, targetId)
  const continuation = continuationFor(chat.continuation, chat.piSessionId, endpointId)
  const {
    resumeId: _resumeId,
    model: _model,
    runtimeId: _runtimeId,
    endpointId: _endpointId,
    connectionId: existingConnection,
    providerId: existingProvider,
    modelId: existingModel,
    continuation: _continuation,
    piSessionId: _piSessionId,
    ...rest
  } = chat

  return {
    ...rest,
    runtimeId: Schema.is(AgentRuntimeId)(chat.runtimeId) ? chat.runtimeId : "pi",
    ...(endpointId === undefined ? {} : { endpointId }),
    ...preservedRuntimeFields({
      connectionId: existingConnection,
      providerId: existingProvider,
      modelId: existingModel
    }),
    ...resolvedFields(chat, resolved, providerId),
    ...(continuation === undefined ? {} : { continuation }),
    connectionSelectionRequired: existingConnection === undefined && resolved === null,
    modelSelectionRequired: existingModel === undefined && resolved === null,
    ...legacyHistory(legacyModel, legacyResumeId)
  }
}

/** Lossless decoder migration from legacy CLI/provider/PI identity to owned endpoints. */
export const migrateLegacyRuntimeIdentity = (
  value: unknown,
  resolve?: LegacyRuntimeResolver
): unknown => {
  if (!Schema.is(LegacySessionObject)(value)) return value
  const targetId = stringOrNull(value.environmentId) ?? "desktop"
  const chats = Array.isArray(value.chats)
    ? value.chats.map((chat) => migrateChat(chat, value.cli, targetId, resolve))
    : value.chats
  const active = Array.isArray(chats)
    ? chats.find(
        (chat) => Schema.is(LegacyChatWithId)(chat) && chat.id === value.activeChatId
      )
    : null
  const activeRecord = Schema.is(LegacyChatObject)(active) ? active : null
  const legacyModel = stringOrNull(activeRecord?.legacyModel) ?? stringOrNull(value.model)
  const legacyResumeId = stringOrNull(activeRecord?.legacyResumeId) ?? stringOrNull(value.resumeId)
  const { providerId, resolved } = resolveLegacyCandidate(value.cli, legacyModel, resolve)
  const endpointId = endpointFor(
    activeRecord?.endpointId ?? value.endpointId,
    activeRecord?.connectionId ?? value.connectionId,
    resolved,
    targetId
  )
  const continuation = Schema.is(RuntimeContinuation)(activeRecord?.continuation)
    ? activeRecord.continuation
    : continuationFor(value.continuation, value.piSessionId, endpointId)
  const {
    cli: _cli,
    resumeId: _resumeId,
    model: _model,
    runtimeId: _runtimeId,
    endpointId: _endpointId,
    continuation: _continuation,
    piSessionId: _piSessionId,
    ...session
  } = value

  return {
    ...session,
    ...(chats === undefined ? {} : { chats }),
    runtimeId: Schema.is(AgentRuntimeId)(value.runtimeId) ? value.runtimeId : "pi",
    ...(endpointId === undefined ? {} : { endpointId }),
    ...resolvedFields(value, resolved, providerId),
    ...(continuation === undefined ? {} : { continuation }),
    connectionSelectionRequired: value.connectionId === undefined && resolved === null,
    modelSelectionRequired: value.modelId === undefined && resolved === null,
    ...(typeof value.cli === "string" ? { legacyCli: value.cli } : {}),
    ...legacyHistory(legacyModel, legacyResumeId)
  }
}

export const migrateLegacyConfigIdentity = (value: unknown): unknown => {
  if (!Schema.is(LegacyConfigObject)(value) || value.defaultConnectionId !== undefined) return value
  const cli = value.defaultCli
  const providerSettings =
    Schema.is(LegacyProviderMap)(value.providers) && typeof cli === "string"
      ? value.providers[cli]
      : null
  const model =
    Schema.is(LegacyProviderSettings)(providerSettings) && typeof providerSettings.defaultModel === "string"
      ? providerSettings.defaultModel
      : null
  const providerId = providerFromLegacy(cli, model)
  return {
    ...value,
    ...(providerId === null ? {} : { defaultProviderId: providerId }),
    connectionSelectionRequired: true
  }
}

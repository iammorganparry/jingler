import type {
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { Schema } from "effect"

const LegacyChatObject = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  resumeId: Schema.optional(Schema.Unknown),
  connectionId: Schema.optional(Schema.Unknown),
  providerId: Schema.optional(Schema.Unknown),
  modelId: Schema.optional(Schema.Unknown),
  piSessionId: Schema.optional(Schema.Unknown),
  legacyModel: Schema.optional(Schema.Unknown),
  legacyResumeId: Schema.optional(Schema.Unknown)
})
const LegacyChatWithId = Schema.Struct({ id: Schema.Unknown })
const LegacySessionObject = Schema.Struct({
  chats: Schema.optional(Schema.Unknown),
  activeChatId: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  resumeId: Schema.optional(Schema.Unknown),
  cli: Schema.optional(Schema.Unknown),
  connectionId: Schema.optional(Schema.Unknown),
  providerId: Schema.optional(Schema.Unknown),
  modelId: Schema.optional(Schema.Unknown),
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
  if (
    cli === "opencode" &&
    typeof model === "string" &&
    model.includes("/")
  ) {
    return model.slice(0, model.indexOf("/")) || null
  }
  return null
}

const migrateChat = (
  chat: unknown,
  legacyCli: unknown,
  resolve?: LegacyRuntimeResolver
): unknown => {
  if (!Schema.is(LegacyChatObject)(chat)) return chat
  const legacyModel = typeof chat.model === "string" ? chat.model : null
  const legacyResumeId =
    typeof chat.resumeId === "string" ? chat.resumeId : null
  const providerId = providerFromLegacy(legacyCli, legacyModel)
  const resolved = resolve?.({
    providerId,
    model: legacyModel,
    cli: typeof legacyCli === "string" ? legacyCli : null
  }) ?? null
  const {
    resumeId: _resumeId,
    model: _model,
    connectionId: existingConnection,
    providerId: existingProvider,
    modelId: existingModel,
    ...rest
  } = chat

  return {
    ...rest,
    ...(existingConnection === undefined && resolved
      ? { connectionId: resolved.connectionId }
      : existingConnection === undefined
        ? {}
        : { connectionId: existingConnection }),
    ...(existingProvider === undefined && (resolved?.providerId ?? providerId)
      ? { providerId: resolved?.providerId ?? providerId }
      : existingProvider === undefined
        ? {}
        : { providerId: existingProvider }),
    ...(existingModel === undefined && resolved
      ? { modelId: resolved.modelId }
      : existingModel === undefined
        ? {}
        : { modelId: existingModel }),
    piSessionId: typeof chat.piSessionId === "string" ? chat.piSessionId : undefined,
    connectionSelectionRequired:
      existingConnection === undefined && resolved === null,
    modelSelectionRequired: existingModel === undefined && resolved === null,
    ...(legacyModel === null ? {} : { legacyModel }),
    ...(legacyResumeId === null ? {} : { legacyResumeId })
  }
}

/** Lossless decoder migration: clear native continuation and require exact certified recovery. */
export const migrateLegacyRuntimeIdentity = (
  value: unknown,
  resolve?: LegacyRuntimeResolver
): unknown => {
  if (!Schema.is(LegacySessionObject)(value)) return value
  const chats = Array.isArray(value.chats)
    ? value.chats.map((chat) => migrateChat(chat, value.cli, resolve))
    : value.chats
  const active = Array.isArray(chats)
    ? chats.find(
        (chat) => Schema.is(LegacyChatWithId)(chat) && chat.id === value.activeChatId
      )
    : null
  const activeRecord = Schema.is(LegacyChatObject)(active) ? active : null
  const legacyModel =
    typeof activeRecord?.legacyModel === "string"
      ? activeRecord.legacyModel
      : typeof value.model === "string"
        ? value.model
        : null
  const legacyResumeId =
    typeof activeRecord?.legacyResumeId === "string"
      ? activeRecord.legacyResumeId
      : typeof value.resumeId === "string"
        ? value.resumeId
        : null
  const providerId = providerFromLegacy(value.cli, legacyModel)
  const resolved = resolve?.({
    providerId,
    model: legacyModel,
    cli: typeof value.cli === "string" ? value.cli : null
  }) ?? null

  const {
    cli: _cli,
    resumeId: _resumeId,
    model: _model,
    ...session
  } = value

  return {
    ...session,
    ...(chats === undefined ? {} : { chats }),
    ...(value.connectionId === undefined && resolved
      ? { connectionId: resolved.connectionId }
      : {}),
    ...(value.providerId === undefined && (resolved?.providerId ?? providerId)
      ? { providerId: resolved?.providerId ?? providerId }
      : {}),
    ...(value.modelId === undefined && resolved
      ? { modelId: resolved.modelId }
      : {}),
    piSessionId:
      typeof value.piSessionId === "string" ? value.piSessionId : undefined,
    connectionSelectionRequired:
      value.connectionId === undefined && resolved === null,
    modelSelectionRequired: value.modelId === undefined && resolved === null,
    ...(typeof value.cli === "string" ? { legacyCli: value.cli } : {}),
    ...(legacyModel === null ? {} : { legacyModel }),
    ...(legacyResumeId === null ? {} : { legacyResumeId }),
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

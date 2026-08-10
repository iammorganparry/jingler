import { Schema } from "effect"
import { AuthRouteKind } from "./model-certification.js"

export const ProviderConnectionId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ProviderConnectionId"))
export type ProviderConnectionId = Schema.Schema.Type<typeof ProviderConnectionId>

export const ProviderId = Schema.String.pipe(Schema.minLength(1), Schema.brand("ProviderId"))
export type ProviderId = Schema.Schema.Type<typeof ProviderId>

export const ProviderModelId = Schema.String.pipe(Schema.minLength(3), Schema.brand("ProviderModelId"))
export type ProviderModelId = Schema.Schema.Type<typeof ProviderModelId>

export const AuthKind = AuthRouteKind
export type AuthKind = Schema.Schema.Type<typeof AuthKind>

export const CodexLoginMethod = Schema.Literal("browser", "device-code")
export type CodexLoginMethod = Schema.Schema.Type<typeof CodexLoginMethod>

/** Renderer-safe OAuth progress. Access and refresh credentials are never events. */
export const ProviderLoginEvent = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("info", "progress"),
    connectionId: ProviderConnectionId,
    message: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("auth-url"),
    connectionId: ProviderConnectionId,
    url: Schema.String,
    instructions: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal("device-code"),
    connectionId: ProviderConnectionId,
    userCode: Schema.String,
    verificationUri: Schema.String,
    expiresInSeconds: Schema.NullOr(Schema.Number)
  })
)
export type ProviderLoginEvent = Schema.Schema.Type<typeof ProviderLoginEvent>

export const AuthStatus = Schema.Literal(
  "disconnected",
  "connecting",
  "authenticated",
  "expired",
  "revoked",
  "reauthentication-required",
  "entitlement-unconfirmed"
)
export type AuthStatus = Schema.Schema.Type<typeof AuthStatus>

export const AccountIdentity = Schema.Struct({
  fingerprint: Schema.String,
  displayLabel: Schema.NullOr(Schema.String)
})
export type AccountIdentity = Schema.Schema.Type<typeof AccountIdentity>

export const SubscriptionStatus = Schema.Struct({
  entitlement: Schema.Literal("active", "unknown", "unavailable", "requires-api-credits"),
  planLabel: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  quotaLabel: Schema.NullOr(Schema.String),
  rateLimitLabel: Schema.NullOr(Schema.String),
  confirmedBillingRoute: Schema.NullOr(Schema.Literal("subscription", "api", "device-environment"))
})
export type SubscriptionStatus = Schema.Schema.Type<typeof SubscriptionStatus>

export const ProviderConnection = Schema.Struct({
  id: ProviderConnectionId,
  providerId: ProviderId,
  authKind: AuthKind,
  account: Schema.NullOr(AccountIdentity),
  targetId: Schema.String,
  status: AuthStatus,
  subscription: SubscriptionStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String
})
export type ProviderConnection = Schema.Schema.Type<typeof ProviderConnection>

/** Renderer-safe provider setup failure; credentials and upstream bodies are excluded. */
export class ProviderConnectionError extends Schema.TaggedError<ProviderConnectionError>()(
  "ProviderConnectionError",
  { message: Schema.String }
) {}

export const ConnectClaudeTokenInput = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  targetId: Schema.String
})
export type ConnectClaudeTokenInput = Schema.Schema.Type<
  typeof ConnectClaudeTokenInput
>

export const StartCodexLoginInput = Schema.Struct({
  id: Schema.String,
  targetId: Schema.String,
  method: CodexLoginMethod
})
export type StartCodexLoginInput = Schema.Schema.Type<
  typeof StartCodexLoginInput
>

export const ProviderConnectionInput = Schema.Struct({
  connectionId: ProviderConnectionId
})
export type ProviderConnectionInput = Schema.Schema.Type<
  typeof ProviderConnectionInput
>

export const SetProviderApiKeyInput = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  apiKey: Schema.String,
  targetId: Schema.String
})
export type SetProviderApiKeyInput = Schema.Schema.Type<
  typeof SetProviderApiKeyInput
>

export const VerifyProviderModelInput = Schema.Struct({
  connectionId: ProviderConnectionId,
  modelId: ProviderModelId
})
export type VerifyProviderModelInput = Schema.Schema.Type<
  typeof VerifyProviderModelInput
>

/** Persist one fully-qualified, certified default without a partial identity write. */
export const SetDefaultProviderModelInput = Schema.Struct({
  connectionId: ProviderConnectionId,
  providerId: ProviderId,
  modelId: ProviderModelId
})
export type SetDefaultProviderModelInput = Schema.Schema.Type<
  typeof SetDefaultProviderModelInput
>

export const SessionRuntimeIdentity = Schema.Struct({
  connectionId: Schema.NullOr(ProviderConnectionId),
  providerId: Schema.NullOr(ProviderId),
  modelId: Schema.NullOr(ProviderModelId),
  piSessionId: Schema.NullOr(Schema.String),
  modelSelectionRequired: Schema.Boolean,
  connectionSelectionRequired: Schema.Boolean,
  legacyCli: Schema.NullOr(Schema.String),
  legacyModel: Schema.NullOr(Schema.String),
  legacyResumeId: Schema.NullOr(Schema.String)
})
export type SessionRuntimeIdentity = Schema.Schema.Type<typeof SessionRuntimeIdentity>

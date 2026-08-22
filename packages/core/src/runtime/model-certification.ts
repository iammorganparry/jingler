import { Schema } from "effect"
import currentRuntimeContracts from "./runtime-contract-versions.json" with { type: "json" }

/** Versions every model certification is bound to. */
export const RuntimeContractVersions = Schema.Struct({
  behavior: Schema.String,
  authentication: Schema.String,
  prompt: Schema.String,
  tools: Schema.String,
  diff: Schema.String,
  policy: Schema.String,
  capabilities: Schema.String,
  piSdk: Schema.String
})
export type RuntimeContractVersions = Schema.Schema.Type<typeof RuntimeContractVersions>

export const CURRENT_RUNTIME_CONTRACTS =
  Schema.decodeUnknownSync(RuntimeContractVersions)(currentRuntimeContracts)

export const AuthRouteKind = Schema.Literal(
  "claude-setup-token",
  "openai-codex-oauth",
  "api-key",
  "device-environment"
)
export type AuthRouteKind = Schema.Schema.Type<typeof AuthRouteKind>

export const CertificationProvenance = Schema.Literal("local", "reviewed-release")
export type CertificationProvenance = Schema.Schema.Type<typeof CertificationProvenance>

export const CapabilityProfile = Schema.Struct({
  id: Schema.String,
  required: Schema.Boolean,
  scenarioIds: Schema.Array(Schema.String)
})
export type CapabilityProfile = Schema.Schema.Type<typeof CapabilityProfile>

export const AuthRouteProfile = Schema.Struct({
  kind: AuthRouteKind,
  /** Provider route actually observed, never a credential or token. */
  observedRoute: Schema.String,
  subscription: Schema.Boolean,
  entitlementConfirmed: Schema.Boolean,
  apiBillingFallbackObserved: Schema.Boolean
})
export type AuthRouteProfile = Schema.Schema.Type<typeof AuthRouteProfile>

export type AuthRouteIdentityInput = Pick<
  AuthRouteProfile,
  "observedRoute" | "subscription"
>

/** Stable, unambiguous identity for the provider route that was actually used. */
export const authRouteIdentity = (route: AuthRouteIdentityInput): string =>
  JSON.stringify([route.observedRoute.trim(), route.subscription])

export const DiffContract = Schema.Struct({
  statuses: Schema.Array(Schema.Literal("A", "M", "D", "R")),
  actualWorkspaceStateRequired: Schema.Boolean,
  terminalReconciliationRequired: Schema.Boolean
})
export type DiffContract = Schema.Schema.Type<typeof DiffContract>

export const EvalResultStatus = Schema.Literal("passed", "failed", "timed-out")
export type EvalResultStatus = Schema.Schema.Type<typeof EvalResultStatus>

export const EvalResult = Schema.Struct({
  scenarioId: Schema.String,
  status: EvalResultStatus,
  failures: Schema.Array(Schema.String),
  /**
   * Fraction of the scenario's matcher checks that held (0..1). Absent on
   * results persisted before partial-credit scoring existed. Hard failures
   * (wrong scenario id, version mismatch, timeout, terminal-event violations)
   * force 0 regardless of matcher outcomes.
   */
  score: Schema.optional(Schema.Number),
  durationMs: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.Number
})
export type EvalResult = Schema.Schema.Type<typeof EvalResult>

export const ModelCertification = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  authRoute: AuthRouteProfile,
  versions: RuntimeContractVersions,
  provenance: CertificationProvenance,
  capabilityProfiles: Schema.Array(Schema.String),
  results: Schema.Array(EvalResult),
  certifiedAt: Schema.String
})
export type ModelCertification = Schema.Schema.Type<typeof ModelCertification>

export const certificationKey = (
  certification: Pick<ModelCertification, "providerId" | "modelId" | "authRoute" | "versions">
): string =>
  [
    certification.providerId,
    certification.modelId,
    certification.authRoute.kind,
    authRouteIdentity(certification.authRoute),
    ...Object.values(certification.versions)
  ].join(":")

export const isCurrentCertification = (
  certification: ModelCertification,
  current: RuntimeContractVersions = CURRENT_RUNTIME_CONTRACTS
): boolean =>
  certification.results.length > 0 &&
  certification.results.every((result) => result.status === "passed") &&
  !certification.authRoute.apiBillingFallbackObserved &&
  (!certification.authRoute.subscription || certification.authRoute.entitlementConfirmed) &&
  Object.entries(current).every(
    ([name, version]) => certification.versions[name as keyof RuntimeContractVersions] === version
  )

export const isReleaseCertification = (certification: ModelCertification): boolean =>
  certification.provenance === "reviewed-release" && isCurrentCertification(certification)

import { Schema } from "effect"
import bundledManifest from "./release-certification-manifest.json" with { type: "json" }
import {
  AuthRouteKind,
  ModelCertification,
  RuntimeContractVersions
} from "./model-certification.js"
import { ProviderId, ProviderModelId } from "./provider-connection.js"

export const ReleaseModelCandidate = Schema.Struct({
  providerId: ProviderId,
  modelId: ProviderModelId,
  authKind: AuthRouteKind
})
export type ReleaseModelCandidate = Schema.Schema.Type<typeof ReleaseModelCandidate>

export const ReleaseCertificationManifest = Schema.Struct({
  format: Schema.Literal("jingler-release-certification-manifest-v1"),
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  versions: RuntimeContractVersions,
  requiredScenarioIds: Schema.Array(Schema.String),
  models: Schema.Array(ModelCertification)
})
export type ReleaseCertificationManifest = Schema.Schema.Type<
  typeof ReleaseCertificationManifest
>

/**
 * Reviewed release evidence embedded into desktop and device builds. The
 * committed document is intentionally empty for development; release jobs
 * replace it with the manifest produced by the exact-commit live matrix.
 */
export const BUNDLED_RELEASE_CERTIFICATION_MANIFEST =
  Schema.decodeUnknownSync(ReleaseCertificationManifest)(bundledManifest)

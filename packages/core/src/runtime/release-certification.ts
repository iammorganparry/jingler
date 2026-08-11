import { Schema } from "effect"
import {
  AuthRouteKind,
  ModelCertification,
  RuntimeContractVersions
} from "./model-certification.js"

export const ReleaseModelCandidate = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  authKind: AuthRouteKind
})
export type ReleaseModelCandidate = Schema.Schema.Type<typeof ReleaseModelCandidate>

export const ReleaseCertificationManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  versions: RuntimeContractVersions,
  requiredScenarioIds: Schema.Array(Schema.String),
  models: Schema.Array(ModelCertification)
})
export type ReleaseCertificationManifest = Schema.Schema.Type<
  typeof ReleaseCertificationManifest
>

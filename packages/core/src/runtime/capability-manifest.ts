import { Schema } from "effect"
import { RuntimeContractVersions } from "./model-certification.js"

export const RuntimeCapabilityManifest = Schema.Struct({
  versions: RuntimeContractVersions,
  toolIds: Schema.Array(Schema.String),
  resourceIds: Schema.Array(Schema.String),
  targetId: Schema.String
})
export type RuntimeCapabilityManifest = Schema.Schema.Type<
  typeof RuntimeCapabilityManifest
>

export const runtimeCapabilitiesMatch = (
  expected: RuntimeCapabilityManifest,
  target: RuntimeCapabilityManifest
): boolean =>
  expected.targetId === target.targetId &&
  Object.entries(expected.versions).every(
    ([key, value]) =>
      target.versions[key as keyof RuntimeContractVersions] === value
  ) &&
  expected.toolIds.every((id) => target.toolIds.includes(id)) &&
  expected.resourceIds.every((id) => target.resourceIds.includes(id))

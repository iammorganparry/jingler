import {
  CURRENT_RUNTIME_CONTRACTS,
  isCurrentCertification,
  type CapabilityProfile,
  type ModelCertification,
  type ReleaseCertificationManifest,
  type ReleaseModelCandidate,
  type RuntimeContractVersions
} from "@jingler/core"
import { Data, Effect } from "effect"

export class ReleaseCertificationError extends Data.TaggedError(
  "ReleaseCertificationError"
)<{ readonly issues: ReadonlyArray<string> }> {}

export interface BuildReleaseManifestInput {
  readonly candidates: ReadonlyArray<ReleaseModelCandidate>
  readonly certifications: ReadonlyArray<ModelCertification>
  readonly profiles: ReadonlyArray<CapabilityProfile>
  readonly versions?: RuntimeContractVersions
  readonly generatedAt: string
}

const routeKey = (value: ReleaseModelCandidate): string =>
  `${value.providerId}:${value.modelId}:${value.authKind}`

const certificationRouteKey = (value: ModelCertification): string =>
  routeKey({
    providerId: value.providerId,
    modelId: value.modelId,
    authKind: value.authRoute.kind
  })

const duplicates = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value)) return true
    seen.add(value)
    return false
  })
}

const missingScenarios = (
  certification: ModelCertification,
  required: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const passed = new Set(
    certification.results
      .filter((result) => result.status === "passed")
      .map((result) => result.scenarioId)
  )
  return required.filter((scenarioId) => !passed.has(scenarioId))
}

const validateCertification = (
  certification: ModelCertification,
  profiles: ReadonlyMap<string, CapabilityProfile>,
  versions: RuntimeContractVersions
): ReadonlyArray<string> => {
  const key = certificationRouteKey(certification)
  const issues: Array<string> = []

  if (
    certification.provenance !== "reviewed-release" ||
    !isCurrentCertification(certification, versions)
  ) {
    issues.push(`${key} is not a reviewed current passing certification`)
  }
  if (certification.authRoute.observedRoute.trim().length === 0) {
    issues.push(`${key} has no confirmed provider route`)
  }

  const duplicateResults = duplicates(certification.results.map((result) => result.scenarioId))
  if (duplicateResults.length > 0) {
    issues.push(`${key} has duplicate scenario results: ${duplicateResults.join(", ")}`)
  }

  for (const profileId of certification.capabilityProfiles) {
    const profile = profiles.get(profileId)
    if (!profile) {
      issues.push(`${key} claims unknown capability profile ${profileId}`)
      continue
    }
    const missing = missingScenarios(certification, profile.scenarioIds)
    if (missing.length > 0) {
      issues.push(`${key} is missing ${profileId} scenarios: ${missing.join(", ")}`)
    }
  }

  return issues
}

export const buildReleaseCertificationManifest = (
  input: BuildReleaseManifestInput
): Effect.Effect<ReleaseCertificationManifest, ReleaseCertificationError> =>
  Effect.gen(function* () {
    const versions = input.versions ?? CURRENT_RUNTIME_CONTRACTS
    const profileEntries = input.profiles.map((profile) => [profile.id, profile] as const)
    const profiles = new Map(profileEntries)
    const requiredProfiles = input.profiles.filter((profile) => profile.required)
    const requiredScenarioIds = [...new Set(
      requiredProfiles.flatMap((profile) => profile.scenarioIds)
    )].sort()
    const issues: Array<string> = []

    const duplicateCandidates = duplicates(input.candidates.map(routeKey))
    if (duplicateCandidates.length > 0) {
      issues.push(`duplicate release candidates: ${duplicateCandidates.join(", ")}`)
    }
    const duplicateProfiles = duplicates(input.profiles.map((profile) => profile.id))
    if (duplicateProfiles.length > 0) {
      issues.push(`duplicate capability profiles: ${duplicateProfiles.join(", ")}`)
    }
    if (requiredScenarioIds.length === 0) {
      issues.push("release certification requires at least one core scenario")
    }

    const models = input.candidates.flatMap((candidate) => {
      const key = routeKey(candidate)
      const matches = input.certifications.filter(
        (certification) => certificationRouteKey(certification) === key
      )
      if (matches.length !== 1) {
        issues.push(
          matches.length === 0
            ? `${key} has no certification`
            : `${key} has multiple certifications`
        )
        return []
      }

      const certification = matches[0]
      if (!certification) return []
      issues.push(...validateCertification(certification, profiles, versions))

      const missingCore = missingScenarios(certification, requiredScenarioIds)
      if (missingCore.length > 0) {
        issues.push(`${key} is missing required scenarios: ${missingCore.join(", ")}`)
      }
      for (const profile of requiredProfiles) {
        if (!certification.capabilityProfiles.includes(profile.id)) {
          issues.push(`${key} is missing required capability profile ${profile.id}`)
        }
      }
      return [certification]
    })

    if (issues.length > 0) {
      return yield* new ReleaseCertificationError({ issues })
    }

    return {
      schemaVersion: 1 as const,
      generatedAt: input.generatedAt,
      versions,
      requiredScenarioIds,
      models: [...models].sort((left, right) =>
        certificationRouteKey(left).localeCompare(certificationRouteKey(right))
      )
    }
  })

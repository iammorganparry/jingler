import {
  allocateMemoryRollout,
  MEMORY_ROLLOUT_POLICY_DEFAULT,
  memoryRolloutArms,
  type MemoryRolloutAssignment,
  type MemoryRolloutPolicy,
  type MemorySourcePublicationMode,
  type MemorySourcePublicationPolicy,
} from "@jingler/core";
import type { MemoryWorkerEnv } from "./env.js";

const basisPoints = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000
    ? parsed
    : fallback;
};

const sourcePublicationPolicy = (
  value: string | undefined,
): MemorySourcePublicationPolicy => {
  const policy = { ...MEMORY_ROLLOUT_POLICY_DEFAULT.sourcePublication };
  for (const entry of (value ?? "").split(",")) {
    const [kind, mode] = entry.split("=").map((part) => part?.trim());
    if (
      kind !== undefined &&
      mode !== undefined &&
      kind in policy &&
      (["disabled", "review", "auto"] as const).includes(
        mode as MemorySourcePublicationMode,
      )
    ) {
      policy[kind as keyof MemorySourcePublicationPolicy] =
        mode as MemorySourcePublicationMode;
    }
  }
  return policy;
};

/** Worker-authoritative rollout policy. Invalid values fail closed to the reviewed baseline. */
export const memoryRolloutPolicyFromEnv = (
  env: MemoryWorkerEnv,
): MemoryRolloutPolicy => ({
  version: 1,
  revision:
    env.MEMORY_ROLLOUT_REVISION?.trim() ||
    MEMORY_ROLLOUT_POLICY_DEFAULT.revision,
  allocationSalt:
    env.MEMORY_ROLLOUT_SALT?.trim() ||
    MEMORY_ROLLOUT_POLICY_DEFAULT.allocationSalt,
  reflectionBasisPoints: basisPoints(
    env.MEMORY_REFLECTION_ROLLOUT_BPS,
    MEMORY_ROLLOUT_POLICY_DEFAULT.reflectionBasisPoints,
  ),
  extractionBasisPoints: basisPoints(
    env.MEMORY_EXTRACTION_ROLLOUT_BPS,
    MEMORY_ROLLOUT_POLICY_DEFAULT.extractionBasisPoints,
  ),
  extractionMode: env.MEMORY_EXTRACTION_MODE === "shadow" ? "shadow" : "review",
  autoPublicationBasisPoints: basisPoints(
    env.MEMORY_AUTO_PUBLICATION_ROLLOUT_BPS,
    MEMORY_ROLLOUT_POLICY_DEFAULT.autoPublicationBasisPoints,
  ),
  relationshipBasisPoints: basisPoints(
    env.MEMORY_RELATIONSHIP_ROLLOUT_BPS,
    MEMORY_ROLLOUT_POLICY_DEFAULT.relationshipBasisPoints,
  ),
  sourcePublication: sourcePublicationPolicy(
    env.MEMORY_SOURCE_PUBLICATION_POLICY,
  ),
});

export const authoritativeMemoryRollout = (
  env: MemoryWorkerEnv,
  organizationId: string,
  sourceId: string,
  supplied?: MemoryRolloutAssignment,
): MemoryRolloutAssignment => {
  const policy = memoryRolloutPolicyFromEnv(env);
  if (supplied === undefined) {
    return allocateMemoryRollout({
      organizationId,
      sessionId: sourceId,
      policy,
    });
  }
  return {
    ...supplied,
    policyRevision: policy.revision,
    arms: [...memoryRolloutArms(policy, supplied.allocationId)],
  };
};

import { canonicalJson, stableContentHash } from "@jingler/memory"
import type { TeamVault } from "./team-vault.js"

export interface VaultDerivedFingerprints {
  readonly acceptedHeads: string
  readonly searchNavigation: string
  readonly graph: string
  readonly analytics: string
}

export interface VaultReconciliationResult {
  readonly rebuilt: {
    readonly pages: number
    readonly revisions: number
    readonly sources: number
  }
  readonly before: VaultDerivedFingerprints
  readonly after: VaultDerivedFingerprints
  readonly converged: boolean
}

const fingerprint = (value: unknown): string => stableContentHash(canonicalJson(value))

export const captureVaultDerivedFingerprints = async (
  vault: TeamVault,
  asOf: string
): Promise<VaultDerivedFingerprints> => {
  const [heads, navigation, graph, analytics] = await Promise.all([
    vault.listPages(),
    vault.navigation(),
    vault.graph({ limit: 500 }, asOf),
    vault.dashboard(asOf)
  ])
  return {
    acceptedHeads: fingerprint(heads),
    searchNavigation: fingerprint(navigation),
    graph: fingerprint(graph),
    analytics: fingerprint(analytics)
  }
}

/** Rebuilds every mutable projection from committed R2 records and reports convergence. */
export const reconcileVaultFromR2 = async (
  vault: TeamVault,
  asOf: string
): Promise<VaultReconciliationResult> => {
  const before = await captureVaultDerivedFingerprints(vault, asOf)
  const rebuilt = await vault.rebuildFromR2()
  const after = await captureVaultDerivedFingerprints(vault, asOf)
  return {
    rebuilt,
    before,
    after,
    converged:
      before.acceptedHeads === after.acceptedHeads &&
      before.searchNavigation === after.searchNavigation &&
      before.graph === after.graph &&
      before.analytics === after.analytics
  }
}

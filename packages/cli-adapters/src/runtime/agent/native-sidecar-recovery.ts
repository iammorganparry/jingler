import type { AgentRunSpec } from "@jingler/core"
import type { AgentRuntimeContext } from "./agent-runtime.js"
import type { NativeSidecarOwner } from "./native-sidecar-owner-store.js"
import type { PiSessionFactory } from "./pi-agent-runtime.js"
import type { RetainedPiSessionRegistry } from "./retained-pi-session-registry.js"

export interface NativeSidecarRecoveryBinding {
  readonly spec: AgentRunSpec
  readonly context: AgentRuntimeContext
  readonly factory: PiSessionFactory
}

/** Register durable owners for lazy, owner-checked sidecar reopen. */
export const registerPersistedNativeSidecarRecoveries = (
  sessions: Pick<RetainedPiSessionRegistry, "registerRecovery">,
  owners: ReadonlyArray<NativeSidecarOwner>,
  bindingFor: (owner: NativeSidecarOwner) => NativeSidecarRecoveryBinding
): void => {
  for (const owner of owners) {
    const binding = bindingFor(owner)
    sessions.registerRecovery(owner, binding.spec, binding.context, binding.factory)
  }
}

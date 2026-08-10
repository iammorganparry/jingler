import type { RemoteSessionCommand } from "@jingler/core"
import type { SessionCommandExecutor } from "./session-handler.js"

export type ManagedCommandFrame =
  | {
      readonly type: "managed-event"
      readonly event: {
        readonly kind: "event" | "complete" | "failed"
        readonly payload: unknown
      }
    }
  | { readonly type: "managed-complete"; readonly payload: unknown }
  | { readonly type: "managed-failed"; readonly payload: unknown }

/** Thin stdio protocol around the same executor used by owned-device tunnels. */
export const runManagedCommand = async (
  command: RemoteSessionCommand,
  executor: SessionCommandExecutor,
  emit: (frame: ManagedCommandFrame) => void
): Promise<void> => {
  try {
    const payload = await executor.execute(command, async (event) => {
      emit({ type: "managed-event", event })
    })
    emit({ type: "managed-complete", payload })
  } catch (error) {
    emit({
      type: "managed-failed",
      payload: {
        code: "operation-failed",
        message: error instanceof Error ? error.message : "Managed operation failed"
      }
    })
  }
}

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

export type ManagedCommandFrameEmitter = (
  frame: ManagedCommandFrame
) => void | Promise<void>

/** Thin stdio protocol around the same executor used by owned-device tunnels. */
export const runManagedCommand = async (
  command: RemoteSessionCommand,
  executor: SessionCommandExecutor,
  emit: ManagedCommandFrameEmitter
): Promise<void> => {
  try {
    const payload = await executor.execute(command, async (event) => {
      await emit({ type: "managed-event", event })
    })
    await emit({ type: "managed-complete", payload })
  } catch (error) {
    await emit({
      type: "managed-failed",
      payload: {
        code: "operation-failed",
        message: error instanceof Error ? error.message : "Managed operation failed"
      }
    })
  }
}

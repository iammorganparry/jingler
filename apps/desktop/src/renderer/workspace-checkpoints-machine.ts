import { assign, fromPromise, setup } from "xstate"
import type { Session, WorkspaceCheckpoint, WorkspaceCheckpointPreview } from "@jingler/core"
export interface CheckpointApi {
  setMode(id: string, enabled: boolean): Promise<Session>
  list(id: string): Promise<ReadonlyArray<WorkspaceCheckpoint>>
  capture(id: string): Promise<WorkspaceCheckpoint>
  preview(id: string, checkpoint: string): Promise<WorkspaceCheckpointPreview>
  restore(id: string, checkpoint: string, token: string): Promise<WorkspaceCheckpoint>
}
interface Input { session: Session; api: CheckpointApi; onSession(session: Session): void }
export const workspaceCheckpointsMachine = setup({
  types: {
    context: {} as Input & { items: ReadonlyArray<WorkspaceCheckpoint>; preview: WorkspaceCheckpointPreview | null; selected: string; action: "list" | "capture" | "enable" | "disable" | "preview" | "restore"; error: string | null },
    input: {} as Input,
    events: {} as { type: "OPEN" | "CANCEL" | "ENABLE" | "DISABLE" | "CAPTURE" | "CONFIRM" | "RETRY" } | { type: "PREVIEW"; id: string }
  },
  actors: {
    operation: fromPromise(async ({ input }: { input: Input & { action: string; selected: string; preview: WorkspaceCheckpointPreview | null } }) => {
      const { api, session, action } = input
      if (action === "enable" || action === "disable") {
        const next = await api.setMode(session.id, action === "enable"); input.onSession(next)
        return { items: await api.list(session.id), preview: null, session: next }
      }
      if (action === "capture") await api.capture(session.id)
      if (action === "restore") {
        if (!input.preview) throw new Error("Preview the restore first.")
        await api.restore(session.id, input.selected, input.preview.token)
      }
      return { items: await api.list(session.id), preview: action === "preview" ? await api.preview(session.id, input.selected) : null, session }
    })
  }
}).createMachine({
  id: "workspace-checkpoints",
  initial: "closed",
  context: ({ input }) => ({ ...input, items: [], preview: null, selected: "", action: "list", error: null }),
  states: {
    closed: { on: { OPEN: { target: "working", actions: assign({ action: "list" }) } } },
    ready: { on: {
      ENABLE: "consent",
      DISABLE: { target: "working", actions: assign({ action: "disable" }) },
      CAPTURE: { target: "working", actions: assign({ action: "capture" }) },
      PREVIEW: { target: "working", actions: assign({ action: "preview", selected: ({ event }) => event.id }) },
      CANCEL: "closed"
    } },
    consent: { on: { CONFIRM: { target: "working", actions: assign({ action: "enable" }) }, CANCEL: "ready" } },
    working: {
      entry: assign({ error: null }),
      invoke: {
        src: "operation", input: ({ context }) => context,
        onDone: [
          { guard: ({ event }) => event.output.preview !== null, target: "confirming", actions: assign(({ event }) => event.output) },
          { target: "ready", actions: assign(({ event }) => event.output) }
        ],
        onError: { target: "failed", actions: assign({ error: ({ event }) => event.error instanceof Error ? event.error.message : String(event.error) }) }
      }
    },
    confirming: { on: { CONFIRM: { target: "working", actions: assign({ action: "restore" }) }, CANCEL: { target: "ready", actions: assign({ preview: null }) } } },
    failed: { on: { RETRY: "working", CANCEL: "ready" } }
  }
})

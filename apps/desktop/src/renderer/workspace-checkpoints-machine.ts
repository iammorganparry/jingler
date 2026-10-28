import { assign, fromPromise, setup } from "xstate"
import type { Session, WorkspaceCheckpoint, WorkspaceCheckpointPreview } from "@jingler/core"
export interface CheckpointApi {
  setMode(id: string, enabled: boolean): Promise<Session>
  list(id: string): Promise<ReadonlyArray<WorkspaceCheckpoint>>
  capture(id: string): Promise<WorkspaceCheckpoint>
  preview(id: string, checkpoint: string): Promise<WorkspaceCheckpointPreview>
  restore(id: string, checkpoint: string, token: string): Promise<WorkspaceCheckpoint>
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
interface Input { session: Session; api: CheckpointApi; onSession(session: Session): void }
export const workspaceCheckpointsMachine = setup({
  types: {
    context: {} as Input & { items: ReadonlyArray<WorkspaceCheckpoint>; preview: WorkspaceCheckpointPreview | null; selected: string; action: "list" | "capture" | "enable" | "disable" | "preview" | "restore"; error: string | null },
    input: {} as Input,
    events: {} as { type: "OPEN"; id?: string } | { type: "CANCEL" | "ENABLE" | "DISABLE" | "CAPTURE" | "CONFIRM" | "RETRY" } | { type: "PREVIEW"; id: string }
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
    // OPEN with an id goes straight to that checkpoint's revert preview (the timeline rail's "Revert to here").
    closed: { on: { OPEN: { target: "working", actions: assign({ action: ({ event }) => event.id ? "preview" : "list", selected: ({ event }) => event.id ?? "" }) } } },
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
        onError: [
          { guard: ({ context }) => context.action === "restore", target: "restoreFailed", actions: assign({ error: ({ event }) => message(event.error) }) },
          { target: "failed", actions: assign({ error: ({ event }) => message(event.error) }) }
        ]
      }
    },
    confirming: { on: { CONFIRM: { target: "working", actions: assign({ action: "restore" }) }, CANCEL: { target: "ready", actions: assign({ preview: null }) } } },
    // A failed restore keeps its preview, so the revert dialog stays on the same file list and RETRY re-runs restore with the same token.
    restoreFailed: { on: { RETRY: "working", CANCEL: { target: "ready", actions: assign({ preview: null }) } } },
    failed: { on: { RETRY: "working", CANCEL: "ready" } }
  }
})

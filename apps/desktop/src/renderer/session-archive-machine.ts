import type { Session } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"
export const sessionArchiveMachine = setup({
  types: {
    context: {} as { session: Session | null; archive: (id: string, acknowledged: boolean) => Promise<Session>; onSession: (session: Session) => void; error: string | null },
    input: {} as { archive: (id: string, acknowledged: boolean) => Promise<Session>; onSession: (session: Session) => void },
    events: {} as { type: "ARCHIVE"; session: Session } | { type: "CONFIRM" | "CANCEL" }
  },
  actors: { archive: fromPromise(async ({ input }: { input: { session: Session; archive: (id: string, acknowledged: boolean) => Promise<Session> } }) => input.archive(input.session.id, Boolean(input.session.checkpointPtyHistory))) }
}).createMachine({
  id: "session-archive", initial: "idle",
  context: ({ input }) => ({ ...input, session: null, error: null }),
  states: {
    idle: { on: { ARCHIVE: [
      { guard: ({ event }) => Boolean(event.session.checkpointPtyHistory), target: "confirming", actions: assign({ session: ({ event }) => event.session, error: null }) },
      { target: "archiving", actions: assign({ session: ({ event }) => event.session, error: null }) }
    ] } },
    confirming: { on: { CONFIRM: "archiving", CANCEL: { target: "idle", actions: assign({ session: null }) } } },
    archiving: { invoke: { src: "archive", input: ({ context }) => ({ session: context.session!, archive: context.archive }), onDone: { target: "idle", actions: [({ context, event }) => context.onSession(event.output), assign({ session: null })] }, onError: { target: "failed", actions: assign({ error: ({ event }) => String(event.error) }) } } },
    failed: { on: { CONFIRM: "archiving", CANCEL: "idle" } }
  }
})

import type { Session } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"
type Input = {
  load: (id: string) => Promise<Session>
  archive: (id: string, acknowledged: boolean) => Promise<Session>
  onSession: (session: Session) => void
}
export const sessionArchiveMachine = setup({
  types: {
    context: {} as Input & { session: Session | null; acknowledged: boolean; error: string | null },
    input: {} as Input,
    events: {} as { type: "ARCHIVE"; session: Session } | { type: "CONFIRM" | "CANCEL" }
  },
  actors: {
    load: fromPromise(({ input }: { input: { id: string; load: Input["load"] } }) => input.load(input.id)),
    archive: fromPromise(({ input }: { input: { id: string; acknowledged: boolean; archive: Input["archive"] } }) => input.archive(input.id, input.acknowledged))
  }
}).createMachine({
  id: "session-archive", initial: "idle",
  context: ({ input }) => ({ ...input, session: null, acknowledged: false, error: null }),
  states: {
    idle: { on: { ARCHIVE: { target: "loading", actions: assign({ session: ({ event }) => event.session, acknowledged: false, error: null }) } } },
    loading: {
      invoke: { src: "load", input: ({ context }) => ({ id: context.session!.id, load: context.load }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.checkpointPtyHistory), target: "confirming", actions: assign({ session: ({ event }) => event.output }) },
          { target: "archiving", actions: assign({ session: ({ event }) => event.output }) }
        ],
        onError: { target: "failed", actions: assign({ error: ({ event }) => String(event.error) }) }
      },
      on: { CANCEL: "idle" }
    },
    confirming: { on: { CONFIRM: { target: "archiving", actions: assign({ acknowledged: true }) }, CANCEL: "idle" } },
    archiving: { invoke: { src: "archive", input: ({ context }) => ({ id: context.session!.id, acknowledged: context.acknowledged, archive: context.archive }), onDone: { target: "idle", actions: [({ context, event }) => context.onSession(event.output), assign({ session: null })] }, onError: { target: "failed", actions: assign({ error: ({ event }) => String(event.error) }) } } },
    failed: { on: { CONFIRM: { target: "loading", actions: assign({ acknowledged: false, error: null }) }, CANCEL: "idle" } }
  }
})

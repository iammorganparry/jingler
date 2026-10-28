import type { Session } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"
type Input = {
  load: (id: string) => Promise<Session>
  archive: (id: string, acknowledged: boolean) => Promise<Session>
  onSession: (session: Session) => void
}
export const sessionArchiveMachine = setup({
  types: {
    context: {} as Input & { session: Session | null; acknowledged: boolean; retrying: boolean; error: string | null },
    input: {} as Input,
    events: {} as { type: "ARCHIVE"; session: Session } | { type: "CONFIRM" | "CANCEL" }
  },
  actors: {
    load: fromPromise(({ input }: { input: { id: string; load: Input["load"] } }) => input.load(input.id)),
    archive: fromPromise(({ input }: { input: { id: string; acknowledged: boolean; archive: Input["archive"] } }) => input.archive(input.id, input.acknowledged))
  }
}).createMachine({
  id: "session-archive", initial: "idle",
  context: ({ input }) => ({ ...input, session: null, acknowledged: false, retrying: false, error: null }),
  states: {
    idle: { on: { ARCHIVE: { target: "loading", actions: assign({ session: ({ event }) => event.session, acknowledged: false, error: null }) } } },
    loading: {
      invoke: { src: "load", input: ({ context }) => ({ id: context.session!.id, load: context.load }),
        onDone: [
          // Every first archive asks. Retry after a failure re-sends the confirmed request, unless the
          // reload shows terminal history that now needs the explicit metadata-only consent.
          { guard: ({ context, event }) => !context.retrying || Boolean(event.output.checkpointPtyHistory), target: "confirming", actions: assign({ session: ({ event }) => event.output }) },
          { target: "archiving", actions: assign({ session: ({ event }) => event.output }) }
        ],
        onError: { target: "failed", actions: assign({ error: ({ event }) => String(event.error) }) }
      },
      on: { CANCEL: "idle" }
    },
    confirming: { on: { CONFIRM: { target: "archiving", actions: assign({ acknowledged: ({ context }) => Boolean(context.session?.checkpointPtyHistory) }) }, CANCEL: "idle" } },
    archiving: { invoke: { src: "archive", input: ({ context }) => ({ id: context.session!.id, acknowledged: context.acknowledged, archive: context.archive }), onDone: { target: "idle", actions: [({ context, event }) => context.onSession(event.output), assign({ session: null })] }, onError: { target: "recovering", actions: assign({ error: ({ event }) => String(event.error) }) } } },
    recovering: {
      invoke: { src: "load", input: ({ context }) => ({ id: context.session!.id, load: context.load }),
        onDone: { target: "failed", actions: [assign({ session: ({ event }) => event.output }), ({ context, event }) => context.onSession(event.output)] },
        onError: { target: "failed" }
      }
    },
    failed: { on: { CONFIRM: { target: "loading", actions: assign({ acknowledged: false, retrying: true, error: null }) }, CANCEL: "idle" } }
  }
})

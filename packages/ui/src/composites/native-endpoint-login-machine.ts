import { assign, fromCallback, fromPromise, setup } from "xstate"

export interface NativeLoginCode {
  loginId: string
  verificationUrl: string
  userCode: string
}
export interface NativeEndpointLoginActions {
  start: (endpointId: string, targetId: string) => Promise<NativeLoginCode>
  cancel: (endpointId: string, targetId: string, loginId: string) => Promise<void>
  refresh: (endpointId: string, targetId: string) => Promise<boolean>
}
interface Input {
  endpointId: string
  targetId: string
  actions: NativeEndpointLoginActions
}
export const nativeEndpointLoginMachine = setup({
  types: {
    input: {} as Input,
    context: {} as Input & { code: NativeLoginCode | null; error: string | null },
    events: {} as { type: "START" | "CANCEL" | "CHECK" } | { type: "CODE"; code: NativeLoginCode } | { type: "ERROR"; error: string }
  },
  actors: {
    login: fromCallback(({ input, sendBack }: { input: Input; sendBack: (event: { type: "CODE"; code: NativeLoginCode } | { type: "ERROR"; error: string }) => void }) => {
      let disposed = false
      let code: NativeLoginCode | undefined
      const cancel = () => code && void input.actions.cancel(input.endpointId, input.targetId, code.loginId).catch(() => undefined)
      void input.actions.start(input.endpointId, input.targetId).then((result) => {
        code = result
        if (disposed) cancel()
        else sendBack({ type: "CODE", code })
      }).catch(() => { if (!disposed) sendBack({ type: "ERROR", error: "Could not start native Codex login" }) })
      return () => { disposed = true; cancel() }
    }),
    refresh: fromPromise(({ input }: { input: Input }) => input.actions.refresh(input.endpointId, input.targetId))
  }
}).createMachine({
  id: "native-endpoint-login",
  context: ({ input }) => ({ ...input, code: null, error: null }),
  initial: "idle",
  states: {
    idle: { on: { START: "active" } },
    active: {
      entry: assign({ code: null, error: null }),
      invoke: { src: "login", input: ({ context }) => context },
      on: {
        CANCEL: "idle",
        ERROR: { target: "idle", actions: assign({ error: ({ event }) => event.error }) },
        CODE: { target: ".waiting", actions: assign({ code: ({ event }) => event.code }) }
      },
      initial: "starting",
      states: {
        starting: {},
        waiting: { on: { CHECK: "checking" } },
        checking: {
          invoke: {
            src: "refresh", input: ({ context }) => context,
            onDone: [
              { guard: ({ event }) => event.output, target: "#native-endpoint-login.done" },
              { target: "waiting", actions: assign({ error: "Sign-in is still pending on this target" }) }
            ],
            onError: { target: "waiting", actions: assign({ error: "Could not refresh this target" }) }
          }
        }
      }
    },
    done: { on: { START: "active" } }
  }
})

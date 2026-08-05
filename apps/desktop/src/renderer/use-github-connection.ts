import { useEffect } from "react"
import { useMachine } from "@xstate/react"
import { githubConnectionMachine } from "./github-connection-machine.js"

/** Thin React binding; all async transitions live in the machine actors. */
export const useGitHubConnection = () => {
  const [state, send] = useMachine(githubConnectionMachine)

  useEffect(
    () =>
      window.jingler.onGithubComplete((payload) => {
        send({ type: "CALLBACK", ...payload })
      }),
    [send]
  )

  return {
    connection: state.context.connection,
    busy:
      state.matches("loading") ||
      state.matches("connecting") ||
      state.matches("refreshing") ||
      state.matches("disconnecting"),
    connect: () => send({ type: "CONNECT" }),
    manage: () => send({ type: "MANAGE" }),
    refresh: () => send({ type: "REFRESH" }),
    disconnect: () => send({ type: "DISCONNECT" }),
    retry: () => send({ type: "RETRY" })
  } as const
}

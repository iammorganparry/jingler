import { useMachine } from "@xstate/react"
import { useMemo } from "react"
import { createEnvironmentMachine } from "./environment-machine.js"
import { rpc } from "./rpc-client.js"

export const useEnvironments = () => {
  const api = useMemo(
    () => ({
      list: rpc.environmentsList,
      refresh: rpc.environmentsRefresh,
      watch: rpc.environmentsWatch,
      suggestHosts: rpc.environmentsSuggestHosts,
      pairSsh: rpc.environmentsPairSsh,
      rename: rpc.environmentsRename,
      revoke: rpc.environmentsRevoke
    }),
    []
  )
  // XState treats a new machine object as a new actor. Recreating it during
  // render makes useMachine replace the actor and immediately render again.
  const machine = useMemo(() => createEnvironmentMachine(api), [api])
  const [snapshot, send] = useMachine(machine)

  return {
    environments: snapshot.context.environments,
    loading: snapshot.context.loading,
    error: snapshot.context.inventoryError,
    snapshot,
    send,
    refresh: () => send({ type: "REFRESH" }),
    rename: (id: string, name: string) =>
      send({ type: "RENAME", id, name }),
    revoke: (id: string) => send({ type: "REVOKE", id })
  }
}
export type EnvironmentsController = ReturnType<typeof useEnvironments>

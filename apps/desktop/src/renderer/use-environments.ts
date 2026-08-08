import { useMachine } from "@xstate/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { Environment } from "@jingler/core"
import { createEnvironmentMachine } from "./environment-machine.js"
import { rpc } from "./rpc-client.js"

export const useEnvironments = () => {
  const [environments, setEnvironments] = useState<ReadonlyArray<Environment>>(
    []
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const api = useMemo(
    () => ({
      suggestHosts: rpc.environmentsSuggestHosts,
      pairLink: rpc.environmentsPairLink,
      pairSsh: rpc.environmentsPairSsh,
      revoke: rpc.environmentsRevoke
    }),
    []
  )
  // XState treats a new machine object as a new actor. Recreating it during
  // render makes useMachine replace the actor and immediately render again.
  const machine = useMemo(() => createEnvironmentMachine(api), [api])
  const [snapshot, send] = useMachine(machine)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEnvironments(await rpc.environmentsRefresh())
      setError(null)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load devices."
      )
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(
    () =>
      rpc.environmentsWatch(
        (next) => {
          setEnvironments(next)
          setError(null)
        },
        (cause) =>
          setError(
            cause instanceof Error
              ? cause.message
              : "Device updates disconnected."
          )
      ),
    []
  )
  useEffect(() => {
    if (!snapshot.matches("connected") || !snapshot.context.environment) return
    setEnvironments((current) => {
      const next = current.filter(
        (item) => item.id !== snapshot.context.environment?.id
      )
      return [...next, snapshot.context.environment!]
    })
  }, [snapshot])
  return {
    environments,
    loading,
    error,
    snapshot,
    send,
    refresh,
    rename: async (id: string, name: string) => {
      const updated = await rpc.environmentsRename(id, name)
      setEnvironments((current) =>
        current.map((item) => (item.id === id ? updated : item))
      )
    },
    revoke: async (id: string) => {
      await rpc.environmentsRevoke(id)
      setEnvironments((current) => current.filter((item) => item.id !== id))
    }
  }
}
export type EnvironmentsController = ReturnType<typeof useEnvironments>

import type { ImportableSession } from "@jingler/core"
import type { ImportSessionsListProps } from "@jingler/ui"
import { useMachine } from "@xstate/react"
import { useEffect } from "react"
import { fromPromise } from "xstate"
import { importSessionsMachine } from "./import-sessions-machine.js"
import { rpc } from "./rpc-client.js"

export function useImportSessions(onComplete?: () => void): ImportSessionsListProps {
  const [state, send] = useMachine(
    importSessionsMachine.provide({
      actors: {
        scan: fromPromise<ReadonlyArray<ImportableSession>>(async () => rpc.sessionsScanImportable()),
        importOne: fromPromise<unknown, ImportableSession>(async ({ input }) =>
          rpc.sessionsImport(input.source, input.nativeSessionId)
        )
      }
    })
  )

  useEffect(() => {
    if (state.matches("done") && onComplete) {
      onComplete()
    }
  }, [state, onComplete])

  const status = state.matches("scanning")
    ? "loading"
    : state.matches("failed")
      ? "error"
      : "ready"

  return {
    candidates: state.context.candidates,
    status,
    error: state.context.error ?? undefined,
    query: state.context.query,
    onQueryChange: (query) => send({ type: "QUERY", query }),
    selected: state.context.selected,
    onToggle: (key) => send({ type: "TOGGLE", key }),
    onImport: () => send({ type: "IMPORT" }),
    onSkip: () => send({ type: "SKIP" }),
    onRetry: () => send({ type: "RETRY" })
  }
}

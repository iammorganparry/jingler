import { useMachine } from "@xstate/react"
import { useMemo } from "react"
import { createRuntimeInspectorMachine } from "./runtime-inspector-machine.js"
import { rpc } from "./rpc-client.js"

const api = {
  latest: rpc.runtimeDiagnosticsLatest,
  export: rpc.runtimeDiagnosticsExport
}

export const useRuntimeInspector = () => {
  const machine = useMemo(() => createRuntimeInspectorMachine(api), [])
  const [snapshot, send] = useMachine(machine)
  return { snapshot, send }
}

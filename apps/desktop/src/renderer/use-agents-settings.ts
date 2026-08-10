import { useMachine } from "@xstate/react"
import { useMemo } from "react"
import { rpc } from "./rpc-client.js"
import { createAgentsSettingsMachine } from "./agents-settings-machine.js"

const api = {
  list: rpc.agentResourcesList,
  detect: () => rpc.agentResourcesDetect(null),
  importFiles: (candidates: Parameters<typeof rpc.agentResourcesImportFiles>[1]) =>
    rpc.agentResourcesImportFiles(null, candidates, { kind: "portable", allowedTargets: [] }),
  setEnabled: rpc.agentResourcesSetEnabled,
  remove: rpc.agentResourcesRemove,
  reveal: rpc.agentResourcesReveal,
  watch: rpc.agentResourcesWatch
}

export const useAgentsSettings = () => {
  const machine = useMemo(() => createAgentsSettingsMachine(api), [])
  const [snapshot, send] = useMachine(machine)
  return { snapshot, send }
}

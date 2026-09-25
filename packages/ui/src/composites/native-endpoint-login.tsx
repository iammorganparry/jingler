import type { AgentEndpoint } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { nativeEndpointLoginMachine, type NativeEndpointLoginActions } from "./native-endpoint-login-machine.js"
import { Button } from "../components/button.js"

export type { NativeEndpointLoginActions } from "./native-endpoint-login-machine.js"

const SECURE_URL = /^https:\/\//u

export function NativeEndpointLogin({ endpoint, actions }: { endpoint: AgentEndpoint; actions?: NativeEndpointLoginActions }) {
  if (endpoint.runtimeId !== "codex" || !actions) return <span>{endpoint.label} · {endpoint.status}</span>
  return <Login endpoint={endpoint} actions={actions} />
}
function Login({ endpoint, actions }: { endpoint: AgentEndpoint; actions: NativeEndpointLoginActions }) {
  const [state, send] = useMachine(nativeEndpointLoginMachine, { input: { endpointId: endpoint.id, targetId: endpoint.targetId, actions } })
  const code = state.context.code
  const url = code && SECURE_URL.test(code.verificationUrl) ? code.verificationUrl : null
  return <fieldset className="flex flex-col gap-2 border-0 p-0 text-xs">
    <legend className="sr-only">Native Codex login {endpoint.targetId}</legend>
    <span>{endpoint.label} · {endpoint.status} · {endpoint.targetId}</span>
    {(state.matches("idle") || state.matches("done")) && endpoint.status === "signed-out" && <Button size="sm" onClick={() => send({ type: "START" })}>Sign in to Codex CLI</Button>}
    {state.matches("active") && <>
      {code && <><span>Device code: <strong>{code.userCode}</strong></span>{url && <a href={url} target="_blank" rel="noreferrer">Open Codex sign-in</a>}
        <Button size="sm" disabled={!state.matches({ active: "waiting" })} onClick={() => send({ type: "CHECK" })}>Check Codex sign-in</Button></>}
      <Button size="sm" onClick={() => send({ type: "CANCEL" })}>Cancel Codex sign-in</Button>
    </>}
    {state.context.error && <span role="alert">{state.context.error}</span>}
  </fieldset>
}

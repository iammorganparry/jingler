import type { ManagedRuntimeEnv } from "./runtime-env.js"
import { INTERNAL_ROUTES } from "./internal-routes.js"

const unregisterRuntimeSession = (
  env: ManagedRuntimeEnv,
  subject: string,
  sessionId: string
): Promise<Response> =>
  env.MANAGED_ACCOUNT.getByName(subject).fetch(
    INTERNAL_ROUTES.managedAccount.sessionUnregister,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, sessionId })
    }
  )

export const destroyRuntimeSession = async (
  env: ManagedRuntimeEnv,
  input: { readonly subject: string; readonly environmentId: string; readonly sessionId: string }
): Promise<void> => {
  const response = await env.MANAGED_SESSION.getByName(input.sessionId).fetch(
    "https://managed-session.internal/v1/destroy",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  )
  if (response.ok) {
    return
  }
  if (response.status !== 409) {
    throw new Error(`Managed runtime cleanup failed (${response.status})`)
  }
  // A partially configured session cannot unregister itself because its
  // ownership scope was never persisted. Release that account slot directly.
  await unregisterRuntimeSession(env, input.subject, input.sessionId)
}

export { unregisterRuntimeSession }

import { nativeCliEndpointId } from "@jingler/core"
import { startCodexEndpointLogin } from "./endpoint.js"
import type { CodexClientOptions } from "./client.js"

/** One bounded, target-owned device-code flow per endpoint. Never stores credentials. */
export const makeCodexEndpointLogin = (options: CodexClientOptions = {}) => {
  const active = new Map<string, Awaited<ReturnType<typeof startCodexEndpointLogin>>>()
  const starting = new Set<string>()
  const validate = (endpointId: string, targetId: string) => {
    if (endpointId !== nativeCliEndpointId(targetId, "codex"))
      throw new Error("This target does not own that native Codex endpoint")
  }
  return {
    async start(endpointId: string, targetId: string) {
      validate(endpointId, targetId)
      if (starting.has(endpointId) || active.has(endpointId) || active.size + starting.size >= 16)
        throw new Error("A native login is already pending")
      starting.add(endpointId)
      try {
        const login = await startCodexEndpointLogin(options)
        active.set(endpointId, login)
        void login.completed.finally(() => {
          if (active.get(endpointId) === login) active.delete(endpointId)
        })
        return { loginId: login.loginId, verificationUrl: login.verificationUrl, userCode: login.userCode }
      } finally { starting.delete(endpointId) }
    },
    async cancel(endpointId: string, targetId: string, loginId: string) {
      validate(endpointId, targetId)
      const login = active.get(endpointId)
      if (!login) return
      if (login.loginId !== loginId) throw new Error("Native login does not belong to this request")
      await login.cancel()
      active.delete(endpointId)
    }
  }
}
export const codexEndpointLogin = makeCodexEndpointLogin()

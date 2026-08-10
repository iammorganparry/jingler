import type { OAuthAuth } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { codexOAuthFlowFrom, makePiCodexOAuthFlow } from "./pi-codex-oauth.js"

describe("pi Codex OAuth adapter", () => {
  it("uses the pinned pi-ai subscription OAuth implementation", () => {
    expect(makePiCodexOAuthFlow()).toBeDefined()
  })

  it("delegates login and refresh without changing rotated credentials", async () => {
    const login = vi.fn(async () => ({
      type: "oauth" as const,
      access: "access-1",
      refresh: "refresh-1",
      expires: 1
    }))
    const refresh = vi.fn(async () => ({
      type: "oauth" as const,
      access: "access-2",
      refresh: "refresh-2",
      expires: 2
    }))
    const flow = codexOAuthFlowFrom({
      name: "Codex",
      isSubscription: true,
      login,
      refresh,
      toAuth: async (credential) => ({ apiKey: credential.access })
    } satisfies OAuthAuth)

    const controller = new AbortController()
    expect(await flow.login({
      signal: controller.signal,
      prompt: async () => "browser",
      notify: () => undefined
    })).toEqual({ access: "access-1", refresh: "refresh-1", expires: 1 })
    expect(await flow.refresh(
      { access: "access-1", refresh: "refresh-1", expires: 1 },
      controller.signal
    )).toEqual({ access: "access-2", refresh: "refresh-2", expires: 2 })
    expect(login).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
  })
})

import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import type { OAuthAuth } from "@earendil-works/pi-ai"
import type { CodexOAuthFlow, OAuthInteraction } from "./auth-broker.js"

/** Adapt pi-ai's pinned provider-owned OAuth implementation to AuthBroker. */
export const codexOAuthFlowFrom = (oauth: OAuthAuth): CodexOAuthFlow => ({
  login: async (interaction: OAuthInteraction) => {
    const credential = await oauth.login({
      signal: interaction.signal,
      prompt: interaction.prompt,
      notify: interaction.notify
    })
    return {
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires
    }
  },
  refresh: async (credential, signal) => {
    const refreshed = await oauth.refresh(
      { type: "oauth", ...credential },
      signal
    )
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires
    }
  }
})

export const makePiCodexOAuthFlow = (): CodexOAuthFlow => {
  const oauth = openaiCodexProvider().auth.oauth
  if (!oauth) throw new Error("Pinned pi-ai OpenAI Codex OAuth is unavailable")
  return codexOAuthFlowFrom(oauth)
}

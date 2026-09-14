import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Effect } from "effect"
import type { McpAuthStore, StoredMcpCredential } from "./mcp-auth-store.js"

const oauth = (current: StoredMcpCredential | null) =>
  current?.type === "oauth" ? current : { type: "oauth" as const }

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)

export const makeMcpOAuthProvider = (
  name: string,
  store: McpAuthStore,
  redirectUrl: string,
  redirectToAuthorization: (url: URL) => void | Promise<void>,
  state: string
): OAuthClientProvider => ({
  redirectUrl,
  clientMetadata: {
    client_name: "Jingler",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  } satisfies OAuthClientMetadata,
  state: () => state,
  clientInformation: async () => {
    const current = await run(store.read(name))
    return current?.type === "oauth" ? current.clientInformation : undefined
  },
  saveClientInformation: (clientInformation: OAuthClientInformationMixed) =>
    run(store.update(name, (current) => ({ ...oauth(current), clientInformation }))),
  tokens: async () => {
    const current = await run(store.read(name))
    return current?.type === "oauth" ? current.tokens : undefined
  },
  saveTokens: (tokens: OAuthTokens) =>
    run(store.update(name, (current) => ({ ...oauth(current), tokens }))),
  redirectToAuthorization,
  saveCodeVerifier: (codeVerifier: string) =>
    run(store.update(name, (current) => ({ ...oauth(current), codeVerifier, state }))),
  codeVerifier: async () => {
    const current = await run(store.read(name))
    if (current?.type !== "oauth" || current.codeVerifier === undefined) {
      throw new Error(`Missing OAuth verifier for MCP server ${name}`)
    }
    return current.codeVerifier
  },
  invalidateCredentials: (scope) =>
    run(store.update(name, (current) => {
      const value = oauth(current)
      if (scope === "all") return { type: "oauth" }
      if (scope === "tokens") {
        const { tokens: _tokens, ...rest } = value
        return rest
      }
      if (scope === "client") {
        const { clientInformation: _client, ...rest } = value
        return rest
      }
      if (scope === "verifier") {
        const { codeVerifier: _verifier, state: _state, ...rest } = value
        return rest
      }
      return value
    }))
})

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Effect } from "effect"
import type { McpAuthStore, StoredMcpCredential } from "./mcp-auth-store.js"

export interface McpOAuthConfig {
  readonly clientId?: string
  readonly clientSecret?: string
  readonly scope?: string
}

type StoredOAuthCredential = Extract<StoredMcpCredential, { readonly type: "oauth" }>

const oauth = (
  current: StoredMcpCredential | null,
  identity: string
): StoredOAuthCredential => current?.type === "oauth" ? current : { type: "oauth", identity }

export const mcpOAuthConfiguredClient = (config: McpOAuthConfig): OAuthClientInformationMixed | undefined =>
  config.clientId === undefined
    ? undefined
    : {
        client_id: config.clientId,
        ...(config.clientSecret === undefined ? {} : { client_secret: config.clientSecret })
      }

export const mcpOAuthClientMetadata = (
  redirectUrl: string,
  scope?: string
): OAuthClientMetadata => ({
  client_name: "Jingler",
  redirect_uris: [redirectUrl],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  ...(scope === undefined ? {} : { scope })
})

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)

/** Persistent provider used only for token attachment/refresh during normal runtime calls. */
export const makeMcpOAuthProvider = (
  name: string,
  identity: string,
  config: McpOAuthConfig,
  store: McpAuthStore,
  redirectToAuthorization: (url: URL) => void | Promise<void>,
  canInvalidate: () => boolean = () => true
): OAuthClientProvider => {
  let verifier: string | undefined
  return {
    redirectUrl: "http://127.0.0.1",
    clientMetadata: mcpOAuthClientMetadata("http://127.0.0.1", config.scope),
    clientInformation: async () => {
      const current = await run(store.read(name, identity))
      return mcpOAuthConfiguredClient(config) ?? (current?.type === "oauth" ? current.clientInformation : undefined)
    },
    saveClientInformation: (clientInformation) =>
      run(store.update(name, identity, (current) => ({ ...oauth(current, identity), clientInformation }))),
    tokens: async () => {
      const current = await run(store.read(name, identity))
      return current?.type === "oauth" ? current.tokens : undefined
    },
    saveTokens: (tokens: OAuthTokens) =>
      run(store.update(name, identity, (current) => ({ ...oauth(current, identity), tokens }))),
    redirectToAuthorization,
    saveCodeVerifier: (value) => { verifier = value },
    codeVerifier: () => {
      if (verifier === undefined) throw new Error(`Missing OAuth verifier for MCP server ${name}`)
      return verifier
    },
    invalidateCredentials: (scope) => {
      if (scope === "verifier") verifier = undefined
      if (!canInvalidate()) return Promise.resolve()
      return run(store.update(name, identity, (current) => {
        const value = oauth(current, identity)
        if (scope === "all") return { type: "oauth", identity }
        if (scope === "tokens") {
          const { tokens: _tokens, ...rest } = value
          return rest
        }
        if (scope === "client" && mcpOAuthConfiguredClient(config) === undefined) {
          const { clientInformation: _client, ...rest } = value
          return rest
        }
        return value
      }))
    }
  }
}

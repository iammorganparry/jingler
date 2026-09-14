import type {
  OAuthClientInformationMixed,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  OAuthClientInformationSchema,
  OAuthClientInformationFullSchema,
  OAuthTokensSchema
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Effect } from "effect"
import {
  readDeviceSecretDocument,
  updateDeviceSecretDocument
} from "./device-secret-document.js"
import type { SecretStoreShape } from "./secret-store.js"

export type StoredMcpCredential =
  | { readonly type: "api-key"; readonly apiKey: string }
  | {
      readonly type: "oauth"
      readonly tokens?: OAuthTokens
      readonly clientInformation?: OAuthClientInformationMixed
      readonly codeVerifier?: string
      readonly state?: string
    }

const key = (name: string): string => encodeURIComponent(name)

const decodeOAuth = (record: Record<string, unknown>): StoredMcpCredential | null => {
  const tokens = record.tokens === undefined ? undefined : OAuthTokensSchema.safeParse(record.tokens)
  if (tokens !== undefined && !tokens.success) return null
  const basicClient = record.clientInformation === undefined
    ? undefined
    : OAuthClientInformationSchema.safeParse(record.clientInformation)
  const fullClient = basicClient === undefined || basicClient.success
    ? undefined
    : OAuthClientInformationFullSchema.safeParse(record.clientInformation)
  if (basicClient !== undefined && !basicClient.success && !fullClient?.success) return null
  const clientInformation = basicClient?.success ? basicClient.data : fullClient?.success ? fullClient.data : undefined
  return {
    type: "oauth",
    ...(tokens?.success ? { tokens: tokens.data } : {}),
    ...(clientInformation === undefined ? {} : { clientInformation }),
    ...(typeof record.codeVerifier === "string" ? { codeVerifier: record.codeVerifier } : {}),
    ...(typeof record.state === "string" ? { state: record.state } : {})
  }
}

const decode = (value: unknown): StoredMcpCredential | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type === "oauth") return decodeOAuth(record)
  return record.type === "api-key" && typeof record.apiKey === "string" && record.apiKey.length > 0
    ? { type: "api-key", apiKey: record.apiKey }
    : null
}

/** Per-server MCP credentials in the existing OS-encrypted device document. */
export class McpAuthStore {
  constructor(private readonly store: SecretStoreShape) {}

  read = (name: string): Effect.Effect<StoredMcpCredential | null> =>
    Effect.promise(async () => {
      const document = await readDeviceSecretDocument(this.store)
      return decode(document.mcpCredentials?.[key(name)])
    })

  write = (name: string, credential: StoredMcpCredential): Effect.Effect<void> =>
    Effect.promise(async () => {
      await updateDeviceSecretDocument(this.store, (document) => ({
        ...document,
        mcpCredentials: { ...document.mcpCredentials, [key(name)]: credential }
      }))
    })

  update = (
    name: string,
    update: (current: StoredMcpCredential | null) => StoredMcpCredential
  ): Effect.Effect<void> =>
    Effect.promise(async () => {
      await updateDeviceSecretDocument(this.store, (document) => ({
        ...document,
        mcpCredentials: {
          ...document.mcpCredentials,
          [key(name)]: update(decode(document.mcpCredentials?.[key(name)]))
        }
      }))
    })

  delete = (name: string): Effect.Effect<void> =>
    Effect.promise(async () => {
      await updateDeviceSecretDocument(this.store, (document) => {
        const credentials = { ...document.mcpCredentials }
        delete credentials[key(name)]
        return { ...document, mcpCredentials: credentials }
      })
    })
}

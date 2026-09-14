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

export type StoredMcpCredential = {
  readonly identity: string
} & (
  | { readonly type: "api-key"; readonly apiKey: string }
  | {
      readonly type: "oauth"
      readonly tokens?: OAuthTokens
      readonly clientInformation?: OAuthClientInformationMixed
    }
)

const keyPrefix = (name: string): string => `${encodeURIComponent(name)}:`
const key = (name: string, identity: string): string => `${keyPrefix(name)}${identity}`

const decodeOAuth = (record: Record<string, unknown>, identity: string): StoredMcpCredential | null => {
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
    identity,
    ...(tokens?.success ? { tokens: tokens.data } : {}),
    ...(clientInformation === undefined ? {} : { clientInformation })
  }
}

const decode = (value: unknown): StoredMcpCredential | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.identity !== "string" || record.identity.length === 0) return null
  if (record.type === "oauth") return decodeOAuth(record, record.identity)
  return record.type === "api-key" && typeof record.apiKey === "string" && record.apiKey.length > 0
    ? { type: "api-key", identity: record.identity, apiKey: record.apiKey }
    : null
}

/** Per-server MCP credentials in the existing OS-encrypted device document. */
export class McpAuthStore {
  constructor(private readonly store: SecretStoreShape) {}

  read = (name: string, identity: string): Effect.Effect<StoredMcpCredential | null> =>
    Effect.promise(async () => {
      const document = await readDeviceSecretDocument(this.store)
      const credential = decode(document.mcpCredentials?.[key(name, identity)])
      return credential?.identity === identity ? credential : null
    })

  write = (name: string, credential: StoredMcpCredential): Effect.Effect<void> =>
    Effect.promise(async () => {
      await updateDeviceSecretDocument(this.store, (document) => ({
        ...document,
        mcpCredentials: { ...document.mcpCredentials, [key(name, credential.identity)]: credential }
      }))
    })

  writeIf = (
    name: string,
    credential: StoredMcpCredential,
    allowed: () => boolean,
    started: () => void
  ): Effect.Effect<boolean> => Effect.promise(async () => {
    let accepted = false
    await updateDeviceSecretDocument(this.store, (document) => {
      if (!allowed()) return document
      accepted = true
      started()
      return {
        ...document,
        mcpCredentials: { ...document.mcpCredentials, [key(name, credential.identity)]: credential }
      }
    })
    return accepted
  })

  update = (
    name: string,
    identity: string,
    update: (current: StoredMcpCredential | null) => StoredMcpCredential
  ): Effect.Effect<void> =>
    Effect.promise(async () => {
      await updateDeviceSecretDocument(this.store, (document) => {
        const current = decode(document.mcpCredentials?.[key(name, identity)])
        if (current?.identity !== identity) return document
        return {
          ...document,
          mcpCredentials: {
            ...document.mcpCredentials,
            [key(name, identity)]: update(current)
          }
        }
      })
    })

  deleteIf = (
    name: string,
    matches: (credential: StoredMcpCredential) => boolean
  ): Effect.Effect<void> =>
    Effect.promise(async () => {
      await updateDeviceSecretDocument(this.store, (document) => {
        const credentials = { ...document.mcpCredentials }
        for (const [credentialKey, encoded] of Object.entries(credentials)) {
          const credential = credentialKey.startsWith(keyPrefix(name)) ? decode(encoded) : null
          if (credential !== null && matches(credential)) delete credentials[credentialKey]
        }
        return { ...document, mcpCredentials: credentials }
      })
    })

  delete = (name: string): Effect.Effect<void> =>
    this.deleteIf(name, () => true)
}

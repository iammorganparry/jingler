import type {
  ConnectorActionResult,
  ConnectorAuthField,
  ConnectorAuthType,
  ConnectorConnection,
  ConnectorProvider,
  OAuthClientInfo
} from "@starbase/core"
import { ConnectorError } from "@starbase/core"
import { Effect } from "effect"
import { ConfigService } from "./config.js"
import { SecretStore } from "./secret-store.js"

/**
 * Typed HTTP client for the self-hosted OpenConnector instance that backs the MCP
 * Connector Center. Mirrors the `fetch` style of `auth.ts`: the base URL comes from
 * `WorkspaceConfig.openConnector.endpoint` and the bearer from `SecretStore`, both
 * read via ACCESSORS inside the methods so this service's construction stays
 * `R = never` (the rule that lets it merge as a bare test peer, see `open-connector.ts`).
 *
 * SECURITY: credentials flow ONE way — api keys, client secrets and OAuth grants
 * go IN on request payloads and are handed to OpenConnector, which owns the vault.
 * Nothing here returns a secret to the renderer; the domain types (`@starbase/core`
 * `connector.ts`) have no field for one.
 *
 * Responses are mapped defensively (never `Schema.decode`, which would throw on an
 * unexpected shape): OpenConnector's exact JSON is confirmed at runtime, so a
 * missing field degrades to a sensible default rather than failing the panel.
 */

/** Per-request wall-clock cap, matching `mcp-probe.ts`'s probe timeout. */
const REQUEST_TIMEOUT = "15 seconds"

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])
const strArray = (v: unknown): ReadonlyArray<string> =>
  arr(v).filter((x): x is string => typeof x === "string")

/** Map a JSON array through `fn`, dropping entries that don't parse. */
const mapArray = <T>(data: unknown, fn: (raw: unknown) => T | undefined): ReadonlyArray<T> =>
  arr(data).flatMap((raw) => {
    const mapped = fn(raw)
    return mapped === undefined ? [] : [mapped]
  })

/** A `RequestInit` for a JSON request body. */
const jsonBody = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
})

/** OpenConnector wraps success payloads in `{ success, message, data, meta }`. */
const envelope = (body: unknown): unknown => (isRecord(body) && "data" in body ? body.data : body)

const AUTH_TYPES: ReadonlyArray<ConnectorAuthType> = ["oauth2", "api_key", "custom_credential"]
const asAuthType = (v: unknown): ConnectorAuthType | undefined =>
  AUTH_TYPES.find((t) => t === v)

const mapField = (raw: unknown): ConnectorAuthField | undefined => {
  if (!isRecord(raw)) return undefined
  const name = str(raw.name) ?? str(raw.key)
  if (name === undefined) return undefined
  // Treat anything that looks secret-bearing as a masked field.
  const secretish = /secret|token|key|password/i.test(name)
  return {
    name,
    label: str(raw.label) ?? name,
    kind: raw.type === "password" || raw.secret === true || secretish ? "password" : "text",
    required: raw.required !== false,
    ...(str(raw.placeholder) !== undefined ? { placeholder: str(raw.placeholder) } : {})
  }
}

const mapFields = (v: unknown): ReadonlyArray<ConnectorAuthField> => mapArray(v, mapField)

/** OAuth client fields to collect when a provider's catalog entry declares none. */
const DEFAULT_CLIENT_FIELDS: ReadonlyArray<ConnectorAuthField> = [
  { name: "clientId", label: "Client ID", kind: "text", required: true },
  { name: "clientSecret", label: "Client secret", kind: "password", required: true }
]

const mapProvider = (raw: unknown): ConnectorProvider | undefined => {
  if (!isRecord(raw)) return undefined
  const id = str(raw.id) ?? str(raw.service) ?? str(raw.slug)
  if (id === undefined) return undefined
  // `auth` may be an array of { type, fields } descriptors; flatten to the union.
  const authEntries = arr(raw.auth)
  const authTypes = authEntries
    .map((a) => (isRecord(a) ? asAuthType(a.type) : undefined))
    .filter((t): t is ConnectorAuthType => t !== undefined)
  // Only api-key / custom-credential descriptors contribute to the connect FORM.
  // An oauth2 descriptor's fields are client-config (id/secret), collected
  // separately from `oauthConfigs`, so folding them in here would corrupt the
  // key form for a provider that offers both.
  const fields = authEntries.flatMap((a) =>
    isRecord(a) && a.type !== "oauth2" ? mapFields(a.fields) : []
  )
  return {
    id,
    name: str(raw.name) ?? str(raw.displayName) ?? id,
    icon: str(raw.icon) ?? str(raw.iconUrl) ?? null,
    authTypes: authTypes.length > 0 ? authTypes : ["api_key"],
    fields,
    actionCount: num(raw.actionCount) ?? num(raw.actions) ?? null
  }
}

const mapConnection = (raw: unknown): ConnectorConnection | undefined => {
  if (!isRecord(raw)) return undefined
  const service = str(raw.service) ?? str(raw.provider)
  if (service === undefined) return undefined
  return {
    service,
    accountId: str(raw.accountId) ?? str(raw.id) ?? "",
    displayName: str(raw.displayName) ?? str(raw.accountName) ?? null,
    grantedScopes: strArray(raw.grantedScopes ?? raw.scopes),
    connectionName: str(raw.connectionName) ?? str(raw.alias) ?? null
  }
}

const mapOAuthConfig = (raw: unknown): OAuthClientInfo | undefined => {
  if (!isRecord(raw)) return undefined
  const provider = str(raw.provider) ?? str(raw.service)
  if (provider === undefined) return undefined
  const clientFields = mapFields(raw.clientConfigFields ?? raw.clientFields)
  return {
    provider,
    expectedRedirectUri: str(raw.expectedRedirectUri) ?? "",
    hasClient: raw.hasClient === true || raw.configured === true,
    clientFields: clientFields.length > 0 ? clientFields : DEFAULT_CLIENT_FIELDS
  }
}

const OK: ConnectorActionResult = { ok: true, message: null }

export class OpenConnectorApi extends Effect.Service<OpenConnectorApi>()(
  "@starbase/OpenConnectorApi",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      /**
       * One authorized request to the instance. Fails with `ConnectorError` when
       * unconfigured, unreachable, or the response is non-OK — never a raw throw.
       * Returns the unwrapped `data` payload (or the raw JSON if not enveloped).
       */
      const call = (path: string, init?: RequestInit) =>
        Effect.gen(function* () {
          const cfg = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
          const base = cfg?.openConnector?.endpoint
          const token = yield* (yield* SecretStore).getOpenConnectorToken
          if (!base || base.length === 0 || token === null || token.length === 0) {
            return yield* Effect.fail(
              new ConnectorError({ message: "OpenConnector is not configured — set an endpoint and token in Settings." })
            )
          }
          const url = `${base.replace(/\/+$/, "")}${path}`
          const res = yield* Effect.tryPromise({
            // `signal` is aborted when the effect is interrupted (e.g. the timeout
            // below fires), so a hung instance actually cancels the socket rather
            // than leaking it — mirroring `mcp-probe.ts`.
            try: (signal) =>
              fetch(url, {
                ...init,
                signal,
                headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
              }),
            catch: () => new ConnectorError({ message: "Couldn't reach the OpenConnector instance." })
          }).pipe(
            Effect.timeoutFail({
              duration: REQUEST_TIMEOUT,
              onTimeout: () => new ConnectorError({ message: `OpenConnector timed out on ${path}.` })
            })
          )
          if (!res.ok) {
            return yield* Effect.fail(
              new ConnectorError({ message: `OpenConnector returned ${res.status} for ${path}.` })
            )
          }
          // 204 / empty bodies are a valid success (PUT/DELETE).
          const body = yield* Effect.tryPromise(() => res.json()).pipe(Effect.orElseSucceed(() => ({})))
          // A 200 can still be a logical failure — the envelope carries `success`.
          if (isRecord(body) && body.success === false) {
            return yield* Effect.fail(
              new ConnectorError({ message: str(body.message) ?? `OpenConnector rejected ${path}.` })
            )
          }
          return envelope(body)
        })

      const listProviders = () =>
        call("/v1/providers").pipe(Effect.map((data) => mapArray(data, mapProvider)))

      const listConnections = () =>
        call("/api/connections").pipe(Effect.map((data) => mapArray(data, mapConnection)))

      const oauthConfigs = () =>
        call("/api/oauth/configs").pipe(Effect.map((data) => mapArray(data, mapOAuthConfig)))

      /** Create/replace an api-key or custom-credential connection. */
      const putConnection = (
        service: string,
        authType: ConnectorAuthType,
        values: Record<string, string>,
        connectionName?: string
      ) =>
        call(
          `/api/connections/${encodeURIComponent(service)}`,
          jsonBody("PUT", { authType, ...(connectionName ? { connectionName } : {}), values })
        ).pipe(Effect.as(OK))

      const deleteConnection = (service: string, connectionName?: string) =>
        call(
          `/api/connections/${encodeURIComponent(service)}${
            connectionName ? `?connectionName=${encodeURIComponent(connectionName)}` : ""
          }`,
          { method: "DELETE" }
        ).pipe(Effect.as(OK))

      /** Store OAuth client credentials for a provider. */
      const putOauthConfig = (
        provider: string,
        clientId: string,
        clientSecret: string,
        extra?: Record<string, string>
      ) =>
        call(
          `/api/oauth/configs/${encodeURIComponent(provider)}`,
          jsonBody("PUT", { clientId, clientSecret, ...(extra ? { extra } : {}) })
        ).pipe(Effect.as(OK))

      /** Begin an OAuth flow; the returned URL is opened in the system browser (main). */
      const startAuthorization = (service: string, connectionName?: string) =>
        call(
          "/api/oauth/authorizations",
          jsonBody("POST", { service, ...(connectionName ? { connectionName } : {}) })
        ).pipe(
          Effect.flatMap((data) => {
            const authorizationUrl = isRecord(data) ? str(data.authorizationUrl) : undefined
            return authorizationUrl
              ? Effect.succeed(authorizationUrl)
              : Effect.fail(new ConnectorError({ message: "OpenConnector did not return an authorization URL." }))
          })
        )

      return {
        listProviders,
        listConnections,
        oauthConfigs,
        putConnection,
        deleteConnection,
        putOauthConfig,
        startAuthorization
      }
    })
  }
) {}

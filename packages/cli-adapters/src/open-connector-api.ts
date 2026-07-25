import type {
  ConnectorActionResult,
  ConnectorAuthField,
  ConnectorAuthType,
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail,
  OAuthClientInfo
} from "@starbase/core"
import { ConnectorError } from "@starbase/core"
import { Effect } from "effect"
import { ConfigService } from "./config.js"
import { SecretStore } from "./secret-store.js"
import { isRecord, normalizeEndpoint, str, strArray } from "./mcp-config.js"

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

// isRecord / str / strArray / normalizeEndpoint are shared from mcp-config.ts.
// `num` and `arr` are local — no equivalent lives in the shared module yet.
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])

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

const AUTH_TYPES: ReadonlyArray<ConnectorAuthType> = [
  "oauth2",
  "api_key",
  "custom_credential",
  // Real, and easy to lose: ~8 providers take no credential and are `configured`
  // on arrival. Dropping it here would fall through to the `["api_key"]` default
  // below and put a credential form in front of a provider that has none.
  "no_auth"
]
const asAuthType = (v: unknown): ConnectorAuthType | undefined =>
  AUTH_TYPES.find((t) => t === v)

/**
 * Category ids. The list endpoint sends `[{ id, displayName }]`; the per-service
 * detail sends bare `["Productivity"]`. Accept both — the grid's filter keys off
 * the id either way.
 */
const mapCategories = (v: unknown): ReadonlyArray<string> =>
  mapArray(v, (raw) =>
    typeof raw === "string" ? raw : isRecord(raw) ? (str(raw.id) ?? str(raw.displayName)) : undefined
  )

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

/**
 * The union of auth kinds a catalog entry advertises. Prefers the flat
 * `authTypes: ["oauth2", "api_key"]` the live instance sends, and falls back to
 * reading the `type` off each `auth[]` descriptor for shapes that only carry
 * the richer form. Empty means "we could not tell" — `api_key` is the safe guess.
 */
const mapAuthTypes = (raw: Record<string, unknown>): ReadonlyArray<ConnectorAuthType> => {
  const flat = mapArray(raw.authTypes, asAuthType)
  if (flat.length > 0) return flat
  const fromDescriptors = mapArray(raw.auth, (a) => (isRecord(a) ? asAuthType(a.type) : undefined))
  return fromDescriptors.length > 0 ? fromDescriptors : ["api_key"]
}

const mapProvider = (raw: unknown): ConnectorProvider | undefined => {
  if (!isRecord(raw)) return undefined
  const id = str(raw.id) ?? str(raw.service) ?? str(raw.slug)
  if (id === undefined) return undefined
  return {
    id,
    name: str(raw.name) ?? str(raw.displayName) ?? id,
    icon: str(raw.icon) ?? str(raw.iconUrl) ?? null,
    categories: mapCategories(raw.categories),
    homepageUrl: str(raw.homepageUrl) ?? str(raw.homepage) ?? null,
    authTypes: mapAuthTypes(raw),
    actionCount: num(raw.actionCount) ?? num(raw.actions) ?? null
  }
}

/**
 * One provider's full descriptor (`GET /api/providers/{service}`).
 *
 * Only api-key / custom-credential descriptors contribute to the connect FORM.
 * An oauth2 descriptor's fields are CLIENT config (id/secret), collected
 * separately via `oauthConfigs`, so folding them in here would corrupt the key
 * form for a provider that offers both — which is most of the ones anyone
 * actually connects.
 */
const mapProviderDetail = (raw: unknown): ConnectorProviderDetail | undefined => {
  if (!isRecord(raw)) return undefined
  const id = str(raw.id) ?? str(raw.service) ?? str(raw.slug)
  if (id === undefined) return undefined
  const authEntries = arr(raw.auth)
  const keyEntries = authEntries.filter(
    (a): a is Record<string, unknown> => isRecord(a) && a.type !== "oauth2" && a.type !== "no_auth"
  )
  // A key descriptor is usually ONE labelled secret (`label`/`placeholder` at the
  // descriptor level) plus optional `extraFields`; a custom_credential descriptor
  // instead carries a `fields` array. Both collapse to the same form.
  const fields = keyEntries.flatMap((a) => {
    const declared = [...mapFields(a.fields), ...mapFields(a.extraFields)]
    const label = str(a.label)
    if (label === undefined) return declared
    const named: ConnectorAuthField = {
      name: "apiKey",
      label,
      kind: "password",
      required: true,
      ...(str(a.placeholder) !== undefined ? { placeholder: str(a.placeholder) } : {})
    }
    return [named, ...declared]
  })
  const oauthScopes = authEntries.flatMap((a) =>
    isRecord(a) && a.type === "oauth2" ? strArray(a.scopes) : []
  )
  const description = keyEntries.map((a) => str(a.description)).find((d) => d !== undefined)
  return {
    id,
    name: str(raw.name) ?? str(raw.displayName) ?? id,
    categories: mapCategories(raw.categories),
    homepageUrl: str(raw.homepageUrl) ?? str(raw.homepage) ?? null,
    authTypes: mapAuthTypes(raw),
    fields,
    oauthScopes,
    actionCount: Array.isArray(raw.actions)
      ? raw.actions.length
      : (num(raw.actionCount) ?? null),
    description: description ?? str(raw.description) ?? null
  }
}

/**
 * The live instance nests the account under `profile` — `{ service, …, profile:
 * { accountId, displayName, grantedScopes } }` — while the flatter shape shows
 * up in older payloads and in the e2e fake. Read `profile` first, fall back to
 * the root.
 *
 * Reading only the root is why every connected row used to render an empty
 * account name and zero scopes: the fields were there, one level down.
 *
 * `connectionName` is normalized: the instance names the default connection
 * "default" rather than omitting it, but `ConnectorConnection` documents null as
 * the default. Passing the string through left one representation on the read
 * path and another on the write path for the same connection — harmless today
 * (the instance resolves both to the same record), and exactly the kind of
 * two-spellings-for-one-thing that the next reader has to re-derive.
 */
const DEFAULT_CONNECTION_NAME = "default"
const mapConnection = (raw: unknown): ConnectorConnection | undefined => {
  if (!isRecord(raw)) return undefined
  const service = str(raw.service) ?? str(raw.provider)
  if (service === undefined) return undefined
  const profile = isRecord(raw.profile) ? raw.profile : raw
  const alias = str(raw.connectionName) ?? str(raw.alias) ?? null
  return {
    service,
    accountId: str(profile.accountId) ?? str(raw.accountId) ?? str(raw.id) ?? "",
    displayName: str(profile.displayName) ?? str(profile.accountName) ?? str(raw.displayName) ?? null,
    grantedScopes: strArray(profile.grantedScopes ?? profile.scopes ?? raw.grantedScopes ?? raw.scopes),
    connectionName: alias === DEFAULT_CONNECTION_NAME ? null : alias,
    // `configured` is the instance's own word for "this credential is usable".
    // Absent (the flat/fake shape) means the entry only exists because it works.
    status: raw.configured === false ? "pending" : "connected"
  }
}

const mapOAuthConfig = (raw: unknown): OAuthClientInfo | undefined => {
  if (!isRecord(raw)) return undefined
  const provider = str(raw.provider) ?? str(raw.service)
  if (provider === undefined) return undefined
  // A handful of providers declare extra client-config inputs, and they hang off
  // the nested `auth` descriptor rather than the root.
  const auth = isRecord(raw.auth) ? raw.auth : {}
  const clientFields = mapFields(
    raw.clientConfigFields ?? raw.clientFields ?? auth.clientConfigFields
  )
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
          const url = `${normalizeEndpoint(base)}${path}`
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

      /**
       * One provider's connect-form shape, fetched when its card is opened.
       *
       * There IS a list endpoint carrying this (`GET /api/providers`) and it must
       * never be called: it inlines every action's JSON Schema for all ~1,100
       * providers and weighs 5 MB. `/v1/providers` (250 KB) feeds the grid; this
       * per-service call (~40 KB) feeds the dialog.
       */
      const getProvider = (service: string) =>
        call(`/api/providers/${encodeURIComponent(service)}`).pipe(
          Effect.flatMap((data) => {
            const detail = mapProviderDetail(data)
            return detail === undefined
              ? Effect.fail(
                  new ConnectorError({ message: `OpenConnector has no provider "${service}".` })
                )
              : Effect.succeed(detail)
          })
        )

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
        getProvider,
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

/**
 * `jingler-telemetry:` — the renderer's only network path to PostHog.
 *
 * The renderer CSP keeps `connect-src` off the internet so a plugin's UI code
 * cannot phone home. PostHog accepts any project token, so allowing its hosts
 * directly would let a plugin ship data into its own project. Instead
 * posthog-js points `api_host` here, and this handler forwards only requests
 * whose every project token is ours, only to our host.
 */
import { gunzipSync } from "node:zlib"
import { protocol, type CustomScheme } from "electron"

export const TELEMETRY_SCHEME = "jingler-telemetry"

export const telemetrySchemePrivileges: CustomScheme = {
  scheme: TELEMETRY_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS"
}

const decodeBody = (raw: Buffer, compression: string | null, contentType: string): unknown => {
  let text = compression === "gzip-js" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8")
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const data = new URLSearchParams(text).get("data") ?? ""
    text = data.trimStart().startsWith("{") || data.trimStart().startsWith("[") ? data : Buffer.from(data, "base64").toString("utf8")
  }
  return JSON.parse(text)
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** Project tokens a capture, batch or flags body claims: top-level `token`/`api_key` plus each event's `properties.token`. */
export const tokensIn = (body: unknown): string[] => {
  const top = isObject(body) ? [body.token, body.api_key] : []
  const events = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.batch) ? body.batch : [body]
  const perEvent = events.map((event) => (isObject(event) && isObject(event.properties) ? event.properties.token : undefined))
  return [...top, ...perEvent].filter((token): token is string => typeof token === "string")
}

export interface ProxyConfig {
  readonly key: string | undefined
  readonly host: string
  readonly fetch: typeof fetch
}

const refuse = (status: number): Response => new Response(null, { status, headers: CORS })

/** The request's body when it claims only our project, else the refusal status. */
async function authorize(request: Request, url: URL, key: string, contentType: string): Promise<{ body?: ArrayBuffer } | number> {
  if (request.method === "GET") {
    return url.pathname.includes(`/${key}/`) || url.searchParams.get("token") === key ? {} : 403
  }
  if (request.method !== "POST") return 405
  const body = await request.arrayBuffer()
  let tokens: string[]
  try {
    tokens = tokensIn(decodeBody(Buffer.from(body), url.searchParams.get("compression"), contentType))
  } catch {
    return 400
  }
  return tokens.length > 0 && tokens.every((token) => token === key) ? { body } : 403
}

/** Forward one renderer request to PostHog, or refuse it. Pure apart from `config.fetch`. */
export async function forwardTelemetry(request: Request, config: ProxyConfig): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  const { key } = config
  if (!key) return refuse(404)
  const url = new URL(request.url)
  const target = new URL(`${url.pathname}${url.search}`, config.host)
  const contentType = request.headers.get("content-type") ?? ""
  const verdict = await authorize(request, url, key, contentType)
  if (typeof verdict === "number") return refuse(verdict)
  const { body } = verdict
  try {
    const upstream = await config.fetch(target, {
      method: request.method,
      headers: contentType ? { "content-type": contentType } : {},
      body
    })
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { ...CORS, "content-type": upstream.headers.get("content-type") ?? "application/json" }
    })
  } catch {
    return refuse(502)
  }
}

/** Install the handler. Call after `app.whenReady()`; the scheme itself is registered with the plugin scheme. */
export const registerTelemetryProtocolHandler = (): void => {
  const config: ProxyConfig = {
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST || "https://eu.i.posthog.com",
    fetch
  }
  protocol.handle(TELEMETRY_SCHEME, (request) => forwardTelemetry(request, config))
}

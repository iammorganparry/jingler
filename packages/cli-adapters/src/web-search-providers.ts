import {
  type WebSearchProvider,
  WebSearchQuery,
  WebSearchError,
  WebSearchResponse
} from "@jingler/core"
import { Either, Schema } from "effect"

const EXA_URL = "https://api.exa.ai/search"
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/search"
const MAX_RESPONSE_BYTES = 512 * 1_024

export interface WebSearchProviderRequest {
  readonly provider: WebSearchProvider
  readonly apiKey: string
  readonly input: Schema.Schema.Type<typeof WebSearchQuery>
  readonly signal: AbortSignal
}

export interface WebSearchProviderDependencies {
  readonly fetch?: typeof fetch
}

const failure = (
  reason: WebSearchError["reason"],
  message: string,
  retryable: boolean
) => new WebSearchError({ reason, message, retryable })

const boundedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw failure("invalid-response", "Search response exceeded its size limit", false)
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw failure("invalid-response", "Search response exceeded its size limit", false)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw failure("invalid-response", "Search provider returned invalid JSON", false)
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : ""

const safeUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 4_096) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
}

const normalize = (
  route: WebSearchProvider,
  values: unknown,
  maxResults: number,
  fields: { readonly snippet: ReadonlyArray<string>; readonly published: ReadonlyArray<string> }
): WebSearchResponse => {
  const entries = Array.isArray(values) ? values : []
  const results = entries.flatMap((value) => {
    const item = record(value)
    const url = safeUrl(item?.url)
    if (item === null || url === null) return []
    const snippet = fields.snippet
      .map((key) => text(item[key], 8_000))
      .find((candidate) => candidate.length > 0) ?? ""
    const publishedAt = fields.published
      .map((key) => text(item[key], 256))
      .find((candidate) => candidate.length > 0) ?? null
    return [{
      title: text(item.title, 512) || url,
      url,
      snippet,
      publishedAt
    }]
  }).slice(0, maxResults)
  const decoded = Schema.decodeUnknownEither(WebSearchResponse)({ route, results }, {
    onExcessProperty: "error"
  })
  if (Either.isLeft(decoded)) {
    throw failure("invalid-response", "Search provider response failed validation", false)
  }
  return decoded.right
}

const providerResponse = async (
  request: WebSearchProviderRequest,
  dependencies: WebSearchProviderDependencies
): Promise<WebSearchResponse> => {
  const endpoint = request.provider === "exa"
    ? (process.env.JINGLER_EXA_URL ?? EXA_URL)
    : (process.env.JINGLER_FIRECRAWL_URL ?? FIRECRAWL_URL)
  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(endpoint, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        ...(request.provider === "exa"
          ? { "x-api-key": request.apiKey }
          : { authorization: `Bearer ${request.apiKey}` })
      },
      body: JSON.stringify(
        request.provider === "exa"
          ? {
              query: request.input.query,
              numResults: request.input.maxResults,
              contents: { text: { maxCharacters: 8_000 } }
            }
          : { query: request.input.query, limit: request.input.maxResults }
      )
    })
  } catch (cause) {
    if (request.signal.aborted) {
      throw failure("cancelled", "Search was cancelled", true)
    }
    throw failure(
      "provider",
      cause instanceof Error ? cause.message : "Search provider request failed",
      true
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw failure("authentication", "Search provider rejected its credential", false)
  }
  if (response.status === 429) {
    throw failure("rate-limited", "Search provider rate limit reached", true)
  }
  if (!response.ok) {
    throw failure("provider", `Search provider returned HTTP ${response.status}`, response.status >= 500)
  }
  const body = record(await boundedJson(response))
  if (body === null) {
    throw failure("invalid-response", "Search provider returned an invalid response", false)
  }
  return request.provider === "exa"
    ? normalize("exa", body.results, request.input.maxResults, {
        snippet: ["text", "summary"],
        published: ["publishedDate"]
      })
    : normalize("firecrawl", body.data, request.input.maxResults, {
        snippet: ["description", "markdown"],
        published: ["publishedDate"]
      })
}

export const searchWithProvider = (
  request: WebSearchProviderRequest,
  dependencies: WebSearchProviderDependencies = {}
): Promise<WebSearchResponse> => providerResponse(request, dependencies)

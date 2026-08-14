import { Schema } from "effect"

/** Search providers whose credentials Jingler can manage without exposing them to an agent. */
export const WebSearchProvider = Schema.Literal("exa", "firecrawl")
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProvider>

/**
 * Persisted operator choice only. API keys are deliberately excluded and live in
 * encrypted credential storage.
 */
export const WebSearchConfig = Schema.Struct({
  setup: Schema.Literal("pending", "skipped", "configured"),
  provider: Schema.NullOr(WebSearchProvider)
})
export type WebSearchConfig = Schema.Schema.Type<typeof WebSearchConfig>

export const WEB_SEARCH_CONFIG_DEFAULT: WebSearchConfig = {
  setup: "pending",
  provider: null
}

export const WebSearchQuery = Schema.Struct({
  query: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000)),
  maxResults: Schema.optionalWith(
    Schema.Int.pipe(Schema.between(1, 10)),
    { default: () => 5 }
  )
})
export type WebSearchQuery = Schema.Schema.Type<typeof WebSearchQuery>

export const WebSearchRoute = Schema.Literal(
  "exa",
  "firecrawl",
  "native",
  "browser"
)
export type WebSearchRoute = Schema.Schema.Type<typeof WebSearchRoute>

export const WebSearchResult = Schema.Struct({
  title: Schema.String.pipe(Schema.maxLength(512)),
  url: Schema.String.pipe(Schema.maxLength(4_096)),
  snippet: Schema.String.pipe(Schema.maxLength(8_000)),
  publishedAt: Schema.NullOr(Schema.String)
})
export type WebSearchResult = Schema.Schema.Type<typeof WebSearchResult>

export const WebSearchResponse = Schema.Struct({
  route: WebSearchRoute,
  results: Schema.Array(WebSearchResult).pipe(Schema.maxItems(10))
})
export type WebSearchResponse = Schema.Schema.Type<typeof WebSearchResponse>

/** Renderer-safe credential state. No saved key or authorization header is returned. */
export const WebSearchCredentialStatus = Schema.Struct({
  provider: WebSearchProvider,
  configured: Schema.Boolean,
  cloudSynced: Schema.Boolean,
  validatedAt: Schema.NullOr(Schema.String)
})
export type WebSearchCredentialStatus = Schema.Schema.Type<
  typeof WebSearchCredentialStatus
>

export const WebSearchSettingsStatus = Schema.Struct({
  config: WebSearchConfig,
  credentials: Schema.Array(WebSearchCredentialStatus).pipe(Schema.maxItems(2))
})
export type WebSearchSettingsStatus = Schema.Schema.Type<
  typeof WebSearchSettingsStatus
>

/** Write-only RPC input; the key must never appear in a success value. */
export const SetWebSearchCredentialInput = Schema.Struct({
  provider: WebSearchProvider,
  apiKey: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(16_384))
})
export type SetWebSearchCredentialInput = Schema.Schema.Type<
  typeof SetWebSearchCredentialInput
>

export const ClearWebSearchCredentialInput = Schema.Struct({
  provider: WebSearchProvider
})
export type ClearWebSearchCredentialInput = Schema.Schema.Type<
  typeof ClearWebSearchCredentialInput
>

export class WebSearchError extends Schema.TaggedError<WebSearchError>()(
  "WebSearchError",
  {
    reason: Schema.Literal(
      "setup-required",
      "unavailable",
      "authentication",
      "rate-limited",
      "provider",
      "invalid-response",
      "cancelled"
    ),
    message: Schema.String,
    retryable: Schema.Boolean
  }
) {}

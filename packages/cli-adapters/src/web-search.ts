import {
  WEB_SEARCH_CONFIG_DEFAULT,
  type WebSearchConfig,
  type WebSearchQuery,
  WebSearchResponse,
  WebSearchError
} from "@jingler/core"
import { FileSystem } from "@effect/platform"
import { Context, Effect, Runtime, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import type { BrowserControlSessionPortShape } from "./browser-control-port.js"
import { WebSearchCredentialService } from "./web-search-credentials.js"
import { searchWithProvider } from "./web-search-providers.js"

export interface WebSearchFallbackPort {
  readonly search: (
    input: WebSearchQuery,
    signal: AbortSignal
  ) => Promise<WebSearchResponse>
}

export interface WebSearchServiceShape {
  readonly chooseSetup?: (
    provider: "exa" | "firecrawl" | null
  ) => Effect.Effect<void, WebSearchError>
  readonly search: (
    input: WebSearchQuery,
    signal: AbortSignal
  ) => Effect.Effect<WebSearchResponse, WebSearchError>
}

export class WebSearchService extends Context.Tag("@jingler/WebSearchService")<
  WebSearchService,
  WebSearchServiceShape
>() {}

export const managedWebSearchServiceFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env
): WebSearchServiceShape | null => {
  const provider = environment.JINGLER_WEB_SEARCH_PROVIDER
  const url = environment.JINGLER_WEB_SEARCH_URL
  const access = environment.JINGLER_PROVIDER_ACCESS
  if (
    (provider !== "exa" && provider !== "firecrawl") ||
    !url ||
    !access
  ) return null

  return {
    search: (input, signal) =>
      fromPromise(() => searchWithProvider({
        provider,
        apiKey: "managed-proxy",
        input,
        signal
      }, {
        fetch: async (_upstream, init) => {
          const headers = new Headers(init?.headers)
          headers.delete("x-api-key")
          headers.set("authorization", `Bearer ${access}`)
          return fetch(url, { ...init, headers })
        }
      }))
  }
}

export const browserWebSearchPort = (
  browser: BrowserControlSessionPortShape
): WebSearchFallbackPort => ({
  search: async (input) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`
    await browser.navigate(url)
    const { result } = await browser.evaluate(`JSON.stringify(
      Array.from(document.querySelectorAll('.result')).slice(0, ${input.maxResults}).map((node) => {
        const link = node.querySelector('.result__a');
        const snippet = node.querySelector('.result__snippet');
        return {
          title: link?.textContent?.trim() || '',
          url: link?.href || '',
          snippet: snippet?.textContent?.trim() || '',
          publishedAt: null
        };
      })
    )`)
    let results: unknown
    try {
      results = JSON.parse(result)
    } catch {
      throw new WebSearchError({
        reason: "invalid-response",
        message: "Browser search returned invalid results",
        retryable: false
      })
    }
    return Schema.decodeUnknownSync(WebSearchResponse)({
      route: "browser",
      results: Array.isArray(results) ? results : []
    }, { onExcessProperty: "error" })
  }
})

export const withWebSearchFallback = (
  primary: WebSearchServiceShape,
  fallback: WebSearchFallbackPort
): WebSearchServiceShape => ({
  ...(primary.chooseSetup ? { chooseSetup: primary.chooseSetup } : {}),
  search: (input, signal) =>
    primary.search(input, signal).pipe(
      Effect.catchAll(() => fromPromise(() => fallback.search(input, signal)))
    )
})

export interface WebSearchServiceOptions {
  /** Verified provider-native server search. Omit when the active model lacks it. */
  readonly native?: WebSearchFallbackPort
  /** Desktop-host contribution. Daemon/device/cloud construction must omit it. */
  readonly browser?: WebSearchFallbackPort
  readonly providerSearch?: typeof searchWithProvider
}

const unavailable = (setupRequired: boolean) =>
  new WebSearchError({
    reason: setupRequired ? "setup-required" : "unavailable",
    message: setupRequired
      ? "WebSearch needs EXA or Firecrawl setup, or a model with native search"
      : "No WebSearch route is available on this runtime target",
    retryable: false
  })

const fromPromise = (
  operation: () => Promise<WebSearchResponse>
): Effect.Effect<WebSearchResponse, WebSearchError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof WebSearchError
        ? cause
        : new WebSearchError({
            reason: "provider",
            message: cause instanceof Error ? cause.message : "WebSearch failed",
            retryable: true
          })
  })

export interface RouteWebSearchInput extends WebSearchServiceOptions {
  readonly config: WebSearchConfig
  readonly query: WebSearchQuery
  readonly signal: AbortSignal
  readonly resolveKey: (provider: "exa" | "firecrawl") => Promise<string | null>
}

/** Pure target-routing seam used by local, device, and managed runtime tests. */
export const routeWebSearch = async (
  input: RouteWebSearchInput
): Promise<WebSearchResponse> => {
  const fallback = async (setupRequired: boolean): Promise<WebSearchResponse> => {
    if (input.native) {
      try {
        return await input.native.search(input.query, input.signal)
      } catch {
        // A target may continue only through a fallback it actually owns.
      }
    }
    if (input.browser) return input.browser.search(input.query, input.signal)
    throw unavailable(setupRequired)
  }

  if (input.config.setup !== "configured" || input.config.provider === null) {
    return fallback(input.config.setup === "pending")
  }
  const apiKey = await input.resolveKey(input.config.provider)
  if (apiKey === null) return fallback(true)
  try {
    return await (input.providerSearch ?? searchWithProvider)({
      provider: input.config.provider,
      apiKey,
      input: input.query,
      signal: input.signal
    })
  } catch {
    return fallback(false)
  }
}

/** Build a target-specific search service. Missing fallbacks are absent, never stubs. */
export const makeWebSearchService = (
  options: WebSearchServiceOptions = {}
): Effect.Effect<
  WebSearchServiceShape,
  never,
  ConfigService | WebSearchCredentialService | FileSystem.FileSystem | AppPaths
> =>
  Effect.gen(function* () {
    const credentials = yield* WebSearchCredentialService
    const configService = yield* ConfigService
    const providerSearch = options.providerSearch ?? searchWithProvider
    const configRuntime = yield* Effect.runtime<FileSystem.FileSystem | AppPaths>()
    const getConfig = () => Runtime.runPromise(configRuntime)(configService.get())

    return {
      chooseSetup: (provider) =>
        fromPromise(async () => {
          await Runtime.runPromise(configRuntime)(
            configService.setWebSearch(
              provider === null
                ? { setup: "skipped", provider: null }
                : { setup: "pending", provider }
            )
          )
          return { route: "native", results: [] }
        }).pipe(Effect.asVoid),
      search: (input, signal) =>
        fromPromise(async () => {
          const config = (await getConfig().catch(() => null))?.webSearch ??
            WEB_SEARCH_CONFIG_DEFAULT
          return routeWebSearch({
            ...options,
            providerSearch,
            config,
            query: input,
            signal,
            resolveKey: (provider) =>
              Effect.runPromise(credentials.resolveKey(provider))
          })
        })
    }
  })

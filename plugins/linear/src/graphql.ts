const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql"
const RATE_LIMIT_CODE = "RATELIMITED"

const hostEnvironment = (): Readonly<Record<string, string | undefined>> => {
  const hostProcess = Reflect.get(globalThis, "process") as
    | { env?: Readonly<Record<string, string | undefined>> }
    | undefined
  return hostProcess?.env ?? {}
}

export type LinearRequest = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>

interface GraphqlError {
  readonly extensions?: { readonly code?: string }
}

interface GraphqlResponse<Data> {
  readonly data?: Data
  readonly errors?: readonly GraphqlError[]
}

const isRateLimited = (errors: readonly GraphqlError[]): boolean =>
  errors.some((error) => error.extensions?.code === RATE_LIMIT_CODE)

export const linearApiUrl = (
  configured: string | undefined = hostEnvironment().JINGLER_LINEAR_API_URL
): string => {
  if (!configured) return DEFAULT_LINEAR_API_URL
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error("The configured Linear API endpoint is invalid.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The configured Linear API endpoint must use HTTP or HTTPS.")
  }
  return url.toString()
}

/**
 * Execute one explicit Linear GraphQL operation.
 *
 * The caller supplies the response type for its explicit operation. Errors
 * never include the request body, response body, variables, or API key.
 */
export interface LinearGraphqlOptions {
  readonly apiKey: string
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>>
  readonly request?: LinearRequest
  readonly endpoint?: string
}

export const linearGraphql = async <Data extends object>(
  options: LinearGraphqlOptions
): Promise<Data> => {
  const request = options.request ?? fetch
  let response: Response
  try {
    response = await request(options.endpoint ?? linearApiUrl(), {
      method: "POST",
      headers: {
        authorization: options.apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({ query: options.query, variables: options.variables ?? {} })
    })
  } catch {
    throw new Error("Linear could not be reached. Check your connection and retry.")
  }

  let payload: GraphqlResponse<Data>
  try {
    payload = (await response.json()) as GraphqlResponse<Data>
  } catch {
    throw new Error(`Linear returned an invalid response (HTTP ${response.status}).`)
  }

  const errors = Array.isArray(payload.errors) ? payload.errors : []
  if (response.status === 401 || response.status === 403) {
    throw new Error("Linear rejected the API key. Replace it in Settings → Plugins → Linear.")
  }
  if (response.status === 429 || isRateLimited(errors)) {
    throw new Error("Linear's rate limit was reached. Wait a moment and retry.")
  }
  if (!response.ok) {
    throw new Error(`Linear could not complete the request (HTTP ${response.status}).`)
  }
  if (errors.length > 0) {
    throw new Error("Linear rejected the request. Check the issue details and retry.")
  }
  if (!payload.data || typeof payload.data !== "object") {
    throw new Error("Linear returned an invalid GraphQL response.")
  }
  return payload.data
}

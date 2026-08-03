import { Data, Effect, Schema } from "effect"

export interface MemoryClientConfig {
  readonly baseUrl: string
  readonly serviceSecret: string
  readonly timeoutMs: number
}

export interface MemoryClientRequest {
  readonly organizationId: string
  readonly requestId: string
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: unknown
  /** Domain responses such as stale-review conflicts remain typed results. */
  readonly acceptedStatuses?: ReadonlyArray<number>
}

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export const JsonValue: Schema.Schema<JsonValue> = Schema.Union(
  Schema.Null,
  Schema.Boolean,
  Schema.String,
  Schema.JsonNumber,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record({ key: Schema.String, value: Schema.suspend(() => JsonValue) })
)

export class MemoryClientError extends Data.TaggedError("MemoryClientError")<{
  readonly status: number
  readonly message: string
  readonly cause?: unknown
}> {}

export interface MemoryClient<Response> {
  readonly request: (input: MemoryClientRequest) => Effect.Effect<Response, MemoryClientError>
}

const workerUrl = (baseUrl: string, path: string): URL => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  return new URL(normalizedPath, normalizedBase)
}

export const createMemoryClient = <Response, Encoded>(
  config: MemoryClientConfig,
  responseSchema: Schema.Schema<Response, Encoded>,
  fetchImplementation: typeof fetch = fetch
): MemoryClient<Response> => ({
  request: (input) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImplementation(workerUrl(config.baseUrl, input.path), {
          method: input.method,
          headers: {
            authorization: `Bearer ${config.serviceSecret}`,
            "content-type": "application/json",
            "x-jingler-organization-id": input.organizationId,
            "x-request-id": input.requestId
          },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: AbortSignal.timeout(config.timeoutMs)
        })
        const text = await response.text()
        if (!response.ok && !input.acceptedStatuses?.includes(response.status)) {
          throw new MemoryClientError({
            status: response.status,
            message: `Memory Worker returned ${response.status}`,
            cause: text
          })
        }
        return text || "null"
      },
      catch: (cause) =>
        cause instanceof MemoryClientError
          ? cause
          : new MemoryClientError({
              status: 502,
              message: "Memory Worker request failed or timed out",
              cause
            })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(responseSchema))),
      Effect.mapError((cause) =>
        cause instanceof MemoryClientError
          ? cause
          : new MemoryClientError({
              status: 502,
              message: "Memory Worker returned invalid response",
              cause
            })
      )
    )
})

import { tokenizeBody } from "@jingler/memory"

/**
 * The embedding boundary. Snippets are embedded HERE (client-side), never by
 * turbopuffer — this account has turbopuffer's native/managed embedding gated off,
 * so we compute vectors ourselves with OpenAI and store them as EXPLICIT vectors.
 *
 * An `Embedder` is injectable: production uses {@link OpenAiEmbedder}; every test
 * uses the deterministic {@link FakeEmbedder}. It maps a batch of texts to a batch
 * of vectors, order-preserving.
 */
export interface Embedder {
  /** Model identifier recorded as suggestion evidence (never a secret). */
  readonly model: string
  /** Output dimensionality (text-embedding-3-small → 1536, -3-large → 3072). */
  readonly dims: number
  /** Embed a batch of texts; the result is aligned index-for-index with the input. */
  embed(texts: ReadonlyArray<string>): Promise<Array<Array<number>>>
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

const hashTerm = (term: string): number => {
  let hash = FNV_OFFSET
  for (let index = 0; index < term.length; index += 1) {
    hash ^= term.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

const normalizeVector = (vector: Array<number>): Array<number> => {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) return vector
  return vector.map((value) => value / norm)
}

/**
 * A deterministic hashed bag-of-words projection: two texts that share vocabulary
 * land close in cosine space, so relatedness tests assert real nearest-neighbour
 * behaviour without a model or a network call. This stands in for OpenAI in tests.
 */
export const deterministicEmbedding = (text: string, dims: number): Array<number> => {
  const vector = new Array<number>(dims).fill(0)
  for (const term of tokenizeBody(text)) {
    const bucket = hashTerm(term) % dims
    // A second hash decides the sign so distinct terms don't only ever add.
    const sign = (hashTerm(`${term}#`) & 1) === 0 ? 1 : -1
    vector[bucket]! += sign
  }
  return normalizeVector(vector)
}

/** The deterministic embedder used by every test and as a safe non-network default. */
export class FakeEmbedder implements Embedder {
  constructor(
    readonly model = "fake-embedding-v1",
    readonly dims = 1_536
  ) {}

  embed(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
    return Promise.resolve(texts.map((text) => deterministicEmbedding(text, this.dims)))
  }
}

/** Default client-side embedding model — OpenAI's text-embedding-3-small (1536 dims). */
export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small"

const KNOWN_OPENAI_EMBED_DIMS: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 1_536,
  "text-embedding-3-large": 3_072
}

const DEFAULT_OPENAI_EMBED_DIMS = 1_536

/** Cap per request so a huge page set is split into several bounded calls. */
const OPENAI_EMBED_BATCH = 256

export interface OpenAiEmbedderOptions {
  readonly apiKey: string
  readonly model?: string
  readonly dims?: number
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

interface OpenAiEmbeddingResponse {
  readonly data?: ReadonlyArray<{ readonly embedding: ReadonlyArray<number>; readonly index: number }>
}

/**
 * Client-side OpenAI embedder: `POST /v1/embeddings` with the whole batch as
 * `input`, mapping each `{ embedding, index }` back by `index` to preserve input
 * order. The key rides only in the Authorization header. A non-2xx response throws
 * so the caller's suggestion path can degrade to lexical-only (never a 500).
 */
export class OpenAiEmbedder implements Embedder {
  readonly model: string
  readonly dims: number
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAiEmbedderOptions) {
    this.apiKey = options.apiKey
    this.model = options.model !== undefined && options.model.length > 0
      ? options.model
      : DEFAULT_OPENAI_EMBED_MODEL
    this.dims = options.dims ?? KNOWN_OPENAI_EMBED_DIMS[this.model] ?? DEFAULT_OPENAI_EMBED_DIMS
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "")
    // Bind the global fetch to globalThis: calling `this.fetchImpl(...)` on the
    // bare global would invoke it as a method of this instance, which the Workers
    // runtime rejects with "Illegal invocation". A passed (fake) fetch is used as-is.
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis)
  }

  async embed(texts: ReadonlyArray<string>): Promise<Array<Array<number>>> {
    if (texts.length === 0) return []
    const out = new Array<Array<number>>(texts.length)
    for (let offset = 0; offset < texts.length; offset += OPENAI_EMBED_BATCH) {
      const batch = texts.slice(offset, offset + OPENAI_EMBED_BATCH)
      const response = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ model: this.model, input: batch })
      })
      if (!response.ok) {
        throw new Error(`openai embeddings request failed: ${response.status}`)
      }
      const body = (await response.json()) as OpenAiEmbeddingResponse
      for (const item of body.data ?? []) {
        out[offset + item.index] = [...item.embedding]
      }
    }
    return out
  }
}

export interface OpenAiEnvLike {
  readonly OPENAI_API_KEY?: string
  /** Non-secret embedding model id; defaults to {@link DEFAULT_OPENAI_EMBED_MODEL}. */
  readonly OPENAI_EMBED_MODEL?: string
}

/** Resolve the client-side embedding model (and its dims) from non-secret Worker env. */
export const resolveOpenAiEmbedModel = (
  env: OpenAiEnvLike
): { readonly model: string; readonly dims: number } => {
  const configured = env.OPENAI_EMBED_MODEL
  const model = configured !== undefined && configured.length > 0
    ? configured
    : DEFAULT_OPENAI_EMBED_MODEL
  return { model, dims: KNOWN_OPENAI_EMBED_DIMS[model] ?? DEFAULT_OPENAI_EMBED_DIMS }
}

/**
 * Build an OpenAI embedder from the Worker env, or `undefined` when no key is set —
 * in which case relatedness degrades to lexical-only. The key is read here and
 * nowhere else, and never crosses to the renderer.
 */
export const createOpenAiEmbedderFromEnv = (
  env: OpenAiEnvLike,
  fetchImpl?: typeof fetch
): Embedder | undefined => {
  const apiKey = env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey.length === 0) return undefined
  const { model, dims } = resolveOpenAiEmbedModel(env)
  return new OpenAiEmbedder({
    apiKey,
    model,
    dims,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl })
  })
}

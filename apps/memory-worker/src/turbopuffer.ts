import { stableContentHash, type MemoryPage } from "@jingler/memory"
import { Effect } from "effect"
import { FakeEmbedder, type Embedder } from "./embeddings.js"

/**
 * The turbopuffer vector layer — an ADVISORY sidecar to the accepted memory
 * store. It holds only page embeddings and a few flat attributes (never bodies),
 * one namespace per organization, and is rebuildable from R2 at any time. It is
 * never consulted by the FTS5 keyword search, the reproducible graph, or any
 * export hash: its only output is scored relatedness for suggestions.
 *
 * Embeddings are EXPLICIT vectors: this account has turbopuffer's native/managed
 * embedding gated off, so we compute vectors ourselves with an {@link Embedder}
 * (OpenAI in production) and upsert precomputed vectors. The page SNIPPET is
 * embedded client-side and NEVER sent to turbopuffer — the namespace holds only
 * the vector and flat attributes (acceptance 08.6).
 *
 * The API key is read ONLY from the Worker env (see {@link createTurbopufferClientFromEnv});
 * it never crosses to the renderer and is never hardcoded.
 */

export interface TurbopufferAttributes {
  readonly contentHash: string
  readonly path: string
  readonly title: string
  readonly revision: number
}

/**
 * A row to upsert. `vector` is precomputed by the {@link Embedder} from the page
 * snippet; the snippet/body itself is never part of the row. Only the vector and
 * the flat attributes leave for the namespace.
 */
export interface TurbopufferDocument {
  readonly id: string
  readonly vector: ReadonlyArray<number>
  readonly attributes: TurbopufferAttributes
}

export interface TurbopufferQueryHit {
  readonly id: string
  /** Cosine similarity in [0, 1]; higher is nearer. */
  readonly similarity: number
  readonly attributes: TurbopufferAttributes
}

export interface TurbopufferStoredHead {
  readonly id: string
  readonly contentHash: string
}

/**
 * The minimal namespace-scoped surface the vector layer needs. A fake
 * implementation ({@link InMemoryTurbopufferClient}) backs every test; the HTTP
 * implementation talks to turbopuffer with a Worker-only key.
 *
 * `upsert` writes precomputed vectors; `query` takes a precomputed query vector
 * and runs ANN. The client never embeds — the {@link Embedder} does.
 */
export interface TurbopufferClient {
  upsert(namespace: string, documents: ReadonlyArray<TurbopufferDocument>): Promise<void>
  query(
    namespace: string,
    vector: ReadonlyArray<number>,
    topK: number
  ): Promise<ReadonlyArray<TurbopufferQueryHit>>
  deleteByIds(namespace: string, ids: ReadonlyArray<string>): Promise<void>
  deleteNamespace(namespace: string): Promise<void>
  /** Ids + content hashes already stored, so re-embedding is skipped when unchanged. */
  heads(namespace: string): Promise<ReadonlyArray<TurbopufferStoredHead>>
}

export interface TurbopufferSyncSummary {
  readonly namespace: string
  readonly embedded: number
  readonly upserted: number
  readonly deleted: number
  readonly unchanged: number
}

export interface TurbopufferNeighbor {
  readonly sourceId: string
  readonly targetId: string
  readonly cosine: number
  readonly rank: number
}

const cosineSimilarity = (
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>
): number => {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

/** Content the embedding is keyed on — body only, so metadata edits don't re-embed. */
const pageContentHash = (page: MemoryPage): string => stableContentHash(page.body)

/**
 * The bounded text handed to the embedder. Whitespace-collapsed and hard capped,
 * so a full page body NEVER leaves for the vector namespace — the namespace holds
 * only the embedding and flat retrieval attributes (acceptance 08.6).
 */
const MAX_EMBED_SNIPPET_CHARS = 1_024

export const embeddingSnippet = (page: MemoryPage): string => {
  const collapsed = page.body.replace(/\s+/g, " ").trim()
  return collapsed.length > MAX_EMBED_SNIPPET_CHARS
    ? collapsed.slice(0, MAX_EMBED_SNIPPET_CHARS)
    : collapsed
}

interface StoredFakeRow {
  readonly id: string
  readonly vector: ReadonlyArray<number>
  readonly attributes: TurbopufferAttributes
}

/**
 * A deterministic in-memory turbopuffer stand-in with true per-namespace
 * isolation, storing EXPLICIT vectors exactly as the HTTP client would. Used by
 * unit tests and as a safe default when no key is configured.
 */
export class InMemoryTurbopufferClient implements TurbopufferClient {
  private readonly namespaces = new Map<string, Map<string, StoredFakeRow>>()

  private ns(namespace: string): Map<string, StoredFakeRow> {
    const existing = this.namespaces.get(namespace)
    if (existing !== undefined) return existing
    const created = new Map<string, StoredFakeRow>()
    this.namespaces.set(namespace, created)
    return created
  }

  upsert(namespace: string, documents: ReadonlyArray<TurbopufferDocument>): Promise<void> {
    if (documents.length === 0) return Promise.resolve()
    const store = this.ns(namespace)
    for (const document of documents) {
      store.set(document.id, {
        id: document.id,
        vector: [...document.vector],
        attributes: document.attributes
      })
    }
    return Promise.resolve()
  }

  query(
    namespace: string,
    vector: ReadonlyArray<number>,
    topK: number
  ): Promise<ReadonlyArray<TurbopufferQueryHit>> {
    const store = this.namespaces.get(namespace)
    if (store === undefined || store.size === 0) return Promise.resolve([])
    const hits = [...store.values()]
      .map((row) => ({
        id: row.id,
        similarity: round6(cosineSimilarity(vector, row.vector)),
        attributes: row.attributes
      }))
      .sort((left, right) => right.similarity - left.similarity || compareText(left.id, right.id))
      .slice(0, Math.max(0, topK))
    return Promise.resolve(hits)
  }

  deleteByIds(namespace: string, ids: ReadonlyArray<string>): Promise<void> {
    const store = this.namespaces.get(namespace)
    if (store !== undefined) for (const id of ids) store.delete(id)
    return Promise.resolve()
  }

  deleteNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace)
    return Promise.resolve()
  }

  heads(namespace: string): Promise<ReadonlyArray<TurbopufferStoredHead>> {
    const store = this.namespaces.get(namespace)
    if (store === undefined) return Promise.resolve([])
    return Promise.resolve(
      [...store.values()]
        .map((row) => ({ id: row.id, contentHash: row.attributes.contentHash }))
        .sort((left, right) => compareText(left.id, right.id))
    )
  }

  /** Test-only: which namespaces currently hold vectors (namespace isolation checks). */
  namespaceKeys(): ReadonlyArray<string> {
    return [...this.namespaces.keys()].sort(compareText)
  }
}

/**
 * Rows fetched per {@link HttpTurbopufferClient.heads} page. `heads()` paginates
 * id-ascending until a short page returns, so this only bounds per-request size —
 * never the total heads surfaced (which must cover the whole namespace or the
 * tail gets needlessly re-embedded).
 */
const HEADS_PAGE_SIZE = 1_000

export interface TurbopufferHttpOptions {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

interface TurbopufferHttpRow {
  readonly id: string
  readonly $dist?: number
  readonly contentHash?: string
  readonly path?: string
  readonly title?: string
  readonly revision?: number
}

/**
 * A thin fetch-based turbopuffer client using EXPLICIT vectors. The key comes from
 * the caller (which reads it from the Worker env) and rides only in the
 * Authorization header. No text or body is ever sent — only vectors and flat
 * attributes.
 */
export class HttpTurbopufferClient implements TurbopufferClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: TurbopufferHttpOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.turbopuffer.com").replace(/\/+$/, "")
    // Bind the global fetch to globalThis: calling `this.fetchImpl(...)` on the
    // bare global would invoke it as a method of this instance, which the Workers
    // runtime rejects with "Illegal invocation". A passed (fake) fetch is used as-is.
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis)
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json"
    }
  }

  private url(namespace: string, suffix = ""): string {
    return `${this.baseUrl}/v2/namespaces/${encodeURIComponent(namespace)}${suffix}`
  }

  async upsert(namespace: string, documents: ReadonlyArray<TurbopufferDocument>): Promise<void> {
    if (documents.length === 0) return
    await this.fetchImpl(this.url(namespace), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        distance_metric: "cosine_distance",
        // Precomputed vectors only — no `text`, no `schema.embed`. The body never
        // leaves for the namespace.
        upsert_rows: documents.map((document) => ({
          id: document.id,
          vector: document.vector,
          contentHash: document.attributes.contentHash,
          path: document.attributes.path,
          title: document.attributes.title,
          revision: document.attributes.revision
        }))
      })
    })
  }

  async query(
    namespace: string,
    vector: ReadonlyArray<number>,
    topK: number
  ): Promise<ReadonlyArray<TurbopufferQueryHit>> {
    const response = await this.fetchImpl(this.url(namespace, "/query"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        // ANN over the precomputed query vector.
        rank_by: ["vector", "ANN", vector],
        top_k: Math.max(1, topK),
        include_attributes: ["contentHash", "path", "title", "revision"]
      })
    })
    if (!response.ok) return []
    const body = (await response.json()) as { readonly rows?: ReadonlyArray<TurbopufferHttpRow> }
    return (body.rows ?? []).map((row) => ({
      id: row.id,
      similarity: round6(1 - (row.$dist ?? 1)),
      attributes: {
        contentHash: row.contentHash ?? "",
        path: row.path ?? "",
        title: row.title ?? "",
        revision: row.revision ?? 0
      }
    }))
  }

  async deleteByIds(namespace: string, ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return
    await this.fetchImpl(this.url(namespace), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ deletes: ids })
    })
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await this.fetchImpl(this.url(namespace), { method: "DELETE", headers: this.headers() })
  }

  async heads(namespace: string): Promise<ReadonlyArray<TurbopufferStoredHead>> {
    // Paginate id-ascending until a short page returns. A single unpaginated
    // top_k would silently cap the result, so a namespace larger than one page
    // would never surface its tail in the stored-hash map — and syncAcceptedPages
    // would then re-embed (OpenAI) and re-upsert every tail page on EVERY sync,
    // an unbounded recurring cost as the namespace grows toward the 10k-page
    // target. After each full page we advance strictly past the last id seen
    // using turbopuffer's v2 comparison filter `[attribute, operator, value]`.
    const heads: Array<TurbopufferStoredHead> = []
    let after: string | undefined
    for (;;) {
      const response = await this.fetchImpl(this.url(namespace, "/query"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          rank_by: ["id", "asc"],
          top_k: HEADS_PAGE_SIZE,
          include_attributes: ["contentHash"],
          ...(after === undefined ? {} : { filters: ["id", "Gt", after] })
        })
      })
      if (!response.ok) break
      const body = (await response.json()) as { readonly rows?: ReadonlyArray<TurbopufferHttpRow> }
      const rows = body.rows ?? []
      for (const row of rows) heads.push({ id: row.id, contentHash: row.contentHash ?? "" })
      const lastId = rows.at(-1)?.id
      if (rows.length < HEADS_PAGE_SIZE || lastId === undefined) break
      after = lastId
    }
    if (heads.length > HEADS_PAGE_SIZE) {
      console.warn(
        `[turbopuffer] namespace ${namespace} holds ${heads.length} heads across multiple pages`
      )
    }
    return heads
  }
}

export interface TurbopufferEnvLike {
  readonly TURBOPUFFER_API_KEY?: string
  readonly TURBOPUFFER_BASE_URL?: string
}

/**
 * Build a client from the Worker env, or `undefined` when no key is configured —
 * in which case relatedness silently degrades to lexical-only. The key is read
 * here and nowhere else.
 */
export const createTurbopufferClientFromEnv = (
  env: TurbopufferEnvLike,
  fetchImpl?: typeof fetch
): TurbopufferClient | undefined => {
  const apiKey = env.TURBOPUFFER_API_KEY
  if (apiKey === undefined || apiKey.length === 0) return undefined
  return new HttpTurbopufferClient({
    apiKey,
    ...(env.TURBOPUFFER_BASE_URL === undefined ? {} : { baseUrl: env.TURBOPUFFER_BASE_URL }),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl })
  })
}

const NAMESPACE_PREFIX = "jingler-memory"

/** Per-organization namespace; isolation is enforced by never crossing this name. */
export const turbopufferNamespace = (organizationId: string, prefix = NAMESPACE_PREFIX): string =>
  `${prefix}--${encodeURIComponent(organizationId)}`

/**
 * Organization-scoped explicit-vector lifecycle over a {@link TurbopufferClient}
 * and an {@link Embedder}. Content-hash keyed so a page's row is re-embedded and
 * re-upserted only when its body changes.
 */
export class TurbopufferVectorLayer {
  private readonly namespace: string

  constructor(
    private readonly client: TurbopufferClient,
    readonly organizationId: string,
    private readonly embedder: Embedder = new FakeEmbedder(),
    prefix = NAMESPACE_PREFIX
  ) {
    this.namespace = turbopufferNamespace(organizationId, prefix)
  }

  /** The embedding model identifier, recorded as suggestion evidence. */
  get embeddingModel(): string {
    return this.embedder.model
  }

  /**
   * Reconcile stored rows with the current accepted pages: embed and upsert only
   * new or content-changed pages, and delete rows for removed pages. Unchanged
   * pages are skipped via the stored content hashes (no embedding call for them).
   */
  syncAcceptedPages(
    pages: ReadonlyArray<MemoryPage>
  ): Effect.Effect<TurbopufferSyncSummary> {
    return Effect.gen(this, function* () {
      const stored = new Map(
        (yield* Effect.promise(() => this.client.heads(this.namespace))).map((head) => [
          head.id,
          head.contentHash
        ])
      )
      const desired = new Set(pages.map((page) => page.id))
      const changed: Array<{ readonly page: MemoryPage; readonly contentHash: string }> = []
      let unchanged = 0
      for (const page of pages) {
        const contentHash = pageContentHash(page)
        if (stored.get(page.id) === contentHash) {
          unchanged += 1
          continue
        }
        changed.push({ page, contentHash })
      }
      const vectors = changed.length === 0
        ? []
        : yield* Effect.promise(() =>
            this.embedder.embed(changed.map((entry) => embeddingSnippet(entry.page)))
          )
      const documents: Array<TurbopufferDocument> = changed.map((entry, index) => ({
        id: entry.page.id,
        vector: vectors[index] ?? [],
        attributes: {
          contentHash: entry.contentHash,
          path: entry.page.path,
          title: entry.page.title,
          revision: entry.page.revision
        }
      }))
      yield* Effect.promise(() => this.client.upsert(this.namespace, documents))
      const removed = [...stored.keys()].filter((id) => !desired.has(id)).sort(compareText)
      yield* Effect.promise(() => this.client.deleteByIds(this.namespace, removed))
      return {
        namespace: this.namespace,
        embedded: documents.length,
        upserted: documents.length,
        deleted: removed.length,
        unchanged
      }
    })
  }

  /** Nearest-neighbour relatedness for one page (self-hit excluded). */
  relatedness(page: MemoryPage, topK: number): Effect.Effect<ReadonlyArray<TurbopufferNeighbor>> {
    return Effect.gen(this, function* () {
      const [vector] = yield* Effect.promise(() => this.embedder.embed([embeddingSnippet(page)]))
      const hits = yield* Effect.promise(() =>
        this.client.query(this.namespace, vector ?? [], topK + 1)
      )
      return hits
        .filter((hit) => hit.id !== page.id)
        .slice(0, topK)
        .map((hit, index) => ({
          sourceId: page.id,
          targetId: hit.id,
          cosine: hit.similarity,
          rank: index
        }))
    })
  }

  /** Relatedness for every page, as a flat neighbour list for suggestion building. */
  allRelatedness(
    pages: ReadonlyArray<MemoryPage>,
    topK: number
  ): Effect.Effect<ReadonlyArray<TurbopufferNeighbor>> {
    return Effect.gen(this, function* () {
      if (pages.length === 0) return []
      // Embed every query snippet in one batch, then ANN-query per page.
      const vectors = yield* Effect.promise(() =>
        this.embedder.embed(pages.map((page) => embeddingSnippet(page)))
      )
      const neighbors: Array<TurbopufferNeighbor> = []
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]!
        const hits = yield* Effect.promise(() =>
          this.client.query(this.namespace, vectors[index] ?? [], topK + 1)
        )
        neighbors.push(
          ...hits
            .filter((hit) => hit.id !== page.id)
            .slice(0, topK)
            .map((hit, rank) => ({
              sourceId: page.id,
              targetId: hit.id,
              cosine: hit.similarity,
              rank
            }))
        )
      }
      return neighbors
    })
  }

  /** Drop and re-embed the whole namespace from R2-derived pages. */
  rebuild(pages: ReadonlyArray<MemoryPage>): Effect.Effect<TurbopufferSyncSummary> {
    return Effect.gen(this, function* () {
      yield* Effect.promise(() => this.client.deleteNamespace(this.namespace))
      return yield* this.syncAcceptedPages(pages)
    })
  }

  /** Remove the organization's namespace entirely. */
  purge(): Effect.Effect<void> {
    return Effect.promise(() => this.client.deleteNamespace(this.namespace))
  }

  namespaceName(): string {
    return this.namespace
  }
}

export interface R2ObjectLike {
  readonly key: string
  readonly etag?: string
  text(): Promise<string>
}

export interface R2ObjectsLike {
  readonly objects: ReadonlyArray<{ readonly key: string }>
  readonly truncated: boolean
  readonly cursor?: string
  /** Common prefixes rolled up to the first `delimiter` past `prefix`, when requested. */
  readonly delimitedPrefixes?: ReadonlyArray<string>
}

export interface R2PutOptionsLike {
  readonly httpMetadata?: { readonly contentType?: string }
  readonly customMetadata?: Readonly<Record<string, string>>
  readonly onlyIf?: { readonly etagDoesNotMatch?: string }
}

export interface R2BucketLike {
  head(key: string): Promise<{ readonly key: string; readonly etag?: string } | null>
  get(key: string): Promise<R2ObjectLike | null>
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: R2PutOptionsLike
  ): Promise<{ readonly key: string } | null>
  list(options?: {
    readonly prefix?: string
    readonly cursor?: string
    readonly delimiter?: string
  }): Promise<R2ObjectsLike>
}

export interface SqlStorageCursor<Row> extends Iterable<Row> {
  readonly rowsWritten: number
  toArray(): Array<Row>
}

export interface SqlStorageLike {
  exec<Row = Record<string, unknown>>(
    query: string,
    ...bindings: ReadonlyArray<string | number | null>
  ): SqlStorageCursor<Row>
}

export interface DurableObjectStorageLike {
  readonly sql: SqlStorageLike
  /**
   * Cloudflare's synchronous, atomic transaction wrapper. `sql.exec` rejects
   * explicit `BEGIN`/`COMMIT`/`ROLLBACK`, so this is the only way to bracket a
   * multi-statement write: the closure runs synchronously and auto-rolls-back
   * if it throws.
   */
  transactionSync<Result>(closure: () => Result): Result
}

export interface DurableObjectIdLike {
  readonly name?: string
  toString(): string
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike
  get(id: DurableObjectIdLike): DurableObjectStubLike
}

export interface WorkflowInstanceStatusLike {
  readonly status: string
  readonly output?: unknown
  readonly error?: unknown
}

export interface WorkflowInstanceLike {
  readonly id: string
  status(): Promise<WorkflowInstanceStatusLike>
  sendEvent?(event: { readonly type: string; readonly payload: unknown }): Promise<void>
}

export interface WorkflowBindingLike<Params> {
  create(options: { readonly id: string; readonly params: Params }): Promise<WorkflowInstanceLike>
  get(id: string): Promise<WorkflowInstanceLike>
}

export interface DurableObjectStateLike {
  readonly id: DurableObjectIdLike
  readonly storage: DurableObjectStorageLike
  blockConcurrencyWhile<Result>(callback: () => Promise<Result>): Promise<Result>
}

export interface MemoryWorkerEnv {
  readonly MEMORY_VAULTS: DurableObjectNamespaceLike
  readonly MEMORY_R2: R2BucketLike
  readonly MEMORY_SERVICE_SECRET: string
  readonly MEMORY_SERVICE_SECRET_PREVIOUS?: string
  /** Stable HMAC key for Workflow instance ids. Never rotate with the service credential. */
  readonly MEMORY_WORKFLOW_ID_SECRET?: string
  readonly MEMORY_COMPILER?: WorkflowBindingLike<import("./workflows/compiler.js").CompilerWorkflowInput>
  readonly MEMORY_LINT?: WorkflowBindingLike<import("./workflows/lint.js").ScheduledLintWorkflowInput>
  readonly MEMORY_VECTOR_INGEST?: WorkflowBindingLike<
    import("./workflows/vector-ingest.js").VectorIngestWorkflowInput
  >
  readonly MEMORY_AUTO_PUBLISH_FIXES?: string
  /**
   * When "true", factual memory changes wait for a human accept in the review
   * queue before publishing (safe mechanical fixes still auto-publish). Unset or
   * anything else = the default trust model: agents publish straight to the
   * shared vault and are audited/reverted after the fact.
   */
  readonly MEMORY_REQUIRE_REVIEW?: string
  readonly MEMORY_LINT_ORGANIZATIONS?: string
  /**
   * Optional explicit allow-list of organizations for the daily vector-ingest drift
   * sweep. The sweep already discovers every org with an R2 vault; this list is a
   * belt-and-braces override for orgs that must always be reconciled.
   */
  readonly MEMORY_VECTOR_ORGANIZATIONS?: string
  /** Advisory vector layer: read ONLY here, never forwarded to the renderer. */
  readonly TURBOPUFFER_API_KEY?: string
  readonly TURBOPUFFER_BASE_URL?: string
  /** Client-side embedding secret; read ONLY here, never forwarded to the renderer. */
  readonly OPENAI_API_KEY?: string
  /** Non-secret embedding model id (defaults to `text-embedding-3-small`). */
  readonly OPENAI_EMBED_MODEL?: string
}

export interface TeamVaultEnv {
  readonly MEMORY_R2: R2BucketLike
  /** Advisory vector layer secret; absent means lexical-only suggestions. */
  readonly TURBOPUFFER_API_KEY?: string
  readonly TURBOPUFFER_BASE_URL?: string
  /** Client-side embedding secret; absent means lexical-only suggestions. */
  readonly OPENAI_API_KEY?: string
  /** Non-secret embedding model id (defaults to `text-embedding-3-small`). */
  readonly OPENAI_EMBED_MODEL?: string
}

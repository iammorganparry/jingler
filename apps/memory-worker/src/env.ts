export interface R2ObjectLike {
  readonly key: string
  readonly etag?: string
  text(): Promise<string>
}

export interface R2ObjectsLike {
  readonly objects: ReadonlyArray<{ readonly key: string }>
  readonly truncated: boolean
  readonly cursor?: string
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
  list(options?: { readonly prefix?: string; readonly cursor?: string }): Promise<R2ObjectsLike>
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
  readonly MEMORY_COMPILER?: WorkflowBindingLike<import("./workflows/compiler.js").CompilerWorkflowInput>
  readonly MEMORY_LINT?: WorkflowBindingLike<import("./workflows/lint.js").ScheduledLintWorkflowInput>
  readonly MEMORY_AUTO_PUBLISH_FIXES?: string
  readonly MEMORY_LINT_ORGANIZATIONS?: string
}

export interface TeamVaultEnv {
  readonly MEMORY_R2: R2BucketLike
}

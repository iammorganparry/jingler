import { MemoryPage as MemoryPageSchema, type MemoryPage } from "@jingler/memory"
import { Effect, Schema } from "effect"
import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { createOpenAiEmbedderFromEnv } from "../embeddings.js"
import type { DurableObjectNamespaceLike } from "../env.js"
import {
  createTurbopufferClientFromEnv,
  TurbopufferVectorLayer,
  type TurbopufferSyncSummary
} from "../turbopuffer.js"
import type { WorkflowStepLike } from "./compiler.js"
import { DurableObjectVaultClient } from "./vault-client.js"

/**
 * The durable, retryable owner of turbopuffer namespace reconciliation. Vector
 * ingestion used to run INLINE on every `suggestions()` read; it now lives here,
 * OFF the read path. This workflow is triggered on accepted publication (a head
 * advance) and, as a drift sweep, on the scheduled cron — the read path is
 * strictly query-only.
 *
 * Each `step.do` is an independent durable retry boundary. Reconciliation is
 * content-hash keyed (see {@link TurbopufferVectorLayer.syncAcceptedPages}): a
 * re-run re-reads the stored heads and re-embeds/upserts only changed pages, so
 * retries and duplicate triggers are safe. When the vector layer is inactive
 * (either the turbopuffer or the OpenAI key is missing) the workflow is a clean
 * no-op.
 */

export interface VectorIngestWorkflowInput {
  readonly organizationId: string
}

/** The accepted-page read the workflow reconciles against (bodies included). */
export interface VectorIngestRepository {
  listAcceptedPages(): Promise<ReadonlyArray<MemoryPage>>
}

export type VectorIngestResult =
  | {
      readonly status: "reconciled"
      readonly organizationId: string
      readonly summary: TurbopufferSyncSummary
    }
  | {
      readonly status: "skipped"
      readonly organizationId: string
      readonly reason: "vector-layer-inactive"
    }

export class VectorIngestWorkflowError extends Error {
  override readonly name = "VectorIngestWorkflowError"
}

export const runVectorIngestWorkflow = async (
  input: VectorIngestWorkflowInput,
  repository: VectorIngestRepository,
  vectorLayer: TurbopufferVectorLayer | undefined,
  step: WorkflowStepLike
): Promise<VectorIngestResult> => {
  // No key configured → advisory vectors are off; nothing to reconcile.
  if (vectorLayer === undefined) {
    return { status: "skipped", organizationId: input.organizationId, reason: "vector-layer-inactive" }
  }
  const pages = await step.do("01-load-accepted-pages", () => repository.listAcceptedPages())
  const summary = await step.do("02-reconcile-turbopuffer-namespace", () =>
    // Content-hash keyed diff vs stored heads: embeds changed snippets via OpenAI,
    // upserts explicit vectors, deletes rows for removed pages, skips unchanged.
    // Idempotent, so a per-step Workflows retry re-runs it safely.
    Effect.runPromise(vectorLayer.syncAcceptedPages(pages))
  )
  return { status: "reconciled", organizationId: input.organizationId, summary }
}

const VaultPageHeads = Schema.Struct({
  pages: Schema.Array(Schema.Struct({ pageId: Schema.String }))
})
const VaultAcceptedPage = Schema.Struct({ page: MemoryPageSchema })

export class DurableObjectVectorIngestRepository implements VectorIngestRepository {
  private readonly client: DurableObjectVaultClient

  constructor(namespace: DurableObjectNamespaceLike, organizationId: string) {
    this.client = new DurableObjectVaultClient(
      namespace,
      organizationId,
      (message) => new VectorIngestWorkflowError(message)
    )
  }

  async listAcceptedPages(): Promise<ReadonlyArray<MemoryPage>> {
    const { pages: heads } = await this.client.request("/internal/memory/pages", VaultPageHeads, {
      requestError: "vault vector-ingest read failed",
      invalidResponse: "vault returned an invalid page list"
    })
    return Promise.all(
      heads.map(async ({ pageId }): Promise<MemoryPage> => {
        const value = await this.client.request(
          `/internal/memory/pages/${encodeURIComponent(pageId)}`,
          VaultAcceptedPage,
          {
            requestError: "vault vector-ingest read failed",
            invalidResponse: "vault returned an invalid accepted page"
          }
        )
        return value.page
      })
    )
  }
}

export interface VectorIngestWorkflowEnv {
  readonly MEMORY_VAULTS: DurableObjectNamespaceLike
  /** Advisory vector layer: read ONLY here, never forwarded to the renderer. */
  readonly TURBOPUFFER_API_KEY?: string
  readonly TURBOPUFFER_BASE_URL?: string
  /** Client-side embedding secret; read ONLY here, never forwarded to the renderer. */
  readonly OPENAI_API_KEY?: string
  readonly OPENAI_EMBED_MODEL?: string
}

/**
 * Build the advisory vector layer only when BOTH a turbopuffer key and an OpenAI
 * key are configured; otherwise the workflow is a clean no-op. Mirrors the
 * DO-side {@link TeamVaultObject} vector-layer gate so both agree on "inactive".
 */
export const vectorLayerFromEnv = (
  env: VectorIngestWorkflowEnv,
  organizationId: string
): TurbopufferVectorLayer | undefined => {
  const client = createTurbopufferClientFromEnv(env)
  const embedder = createOpenAiEmbedderFromEnv(env)
  return client === undefined || embedder === undefined
    ? undefined
    : new TurbopufferVectorLayer(client, organizationId, embedder)
}

export class MemoryVectorIngestWorkflow extends WorkflowEntrypoint<
  VectorIngestWorkflowEnv,
  VectorIngestWorkflowInput
> {
  override run(
    event: WorkflowEvent<VectorIngestWorkflowInput>,
    step: WorkflowStep
  ): Promise<VectorIngestResult> {
    const { organizationId } = event.payload
    return runVectorIngestWorkflow(
      event.payload,
      new DurableObjectVectorIngestRepository(this.env.MEMORY_VAULTS, organizationId),
      vectorLayerFromEnv(this.env, organizationId),
      step as WorkflowStepLike
    )
  }
}

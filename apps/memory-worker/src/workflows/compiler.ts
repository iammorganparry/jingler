import {
  MemoryPage as MemoryPageSchema,
  MemorySource as MemorySourceSchema,
  canonicalJson,
  findCredentialShapedContent,
  parseMemoryPage,
  serializeMemoryMarkdown,
  stableContentHash,
  type MemoryPage,
  type MemorySource
} from "@jingler/memory"
import { Schema } from "effect"
import { buildCompilerPrompt } from "../compiler-prompt.js"
import type { DurableObjectNamespaceLike } from "../env.js"
import {
  isConfiguredMechanicalFix,
  type CreateProposalSetInput,
  type ProposalChangeKind,
  type ProposalSetDraft,
  type VaultProposalSet
} from "../proposals.js"
import { DurableObjectVaultClient } from "./vault-client.js"

export const MAX_COMPILER_SOURCE_CHARACTERS = 32_000
export const MAX_COMPILER_CLAIMS = 12
export const MAX_COMPILER_CANDIDATES = 12
export const MAX_COMPILED_PAGES = 3

export interface CompilerWorkflowInput {
  readonly workflowId: string
  readonly organizationId: string
  readonly sourceId: string
  readonly requestedBy: string
  readonly createdAt: string
  readonly autoPublishFixes?: ReadonlyArray<string>
}

export interface CompilerAcceptedPage {
  readonly page: MemoryPage
  readonly revisionId: string
}

export interface CompilerSource {
  readonly source: MemorySource
  readonly content: string
}

export interface CompilerContext {
  readonly source: MemorySource
  readonly claims: ReadonlyArray<string>
  readonly schemaPages: ReadonlyArray<MemoryPage>
  readonly candidates: ReadonlyArray<CompilerAcceptedPage>
  readonly indexMarkdown: string
  readonly prompt: string
}

export interface CompilerGeneratedProposal {
  readonly changeKind: ProposalChangeKind
  readonly drafts: ReadonlyArray<ProposalSetDraft>
}

export interface CompilerModel {
  generate(context: CompilerContext): Promise<CompilerGeneratedProposal>
}

export interface CompilerRepository {
  readSource(sourceId: string): Promise<CompilerSource>
  listAcceptedPages(): Promise<ReadonlyArray<CompilerAcceptedPage>>
  readNavigation(): Promise<{ readonly indexMarkdown: string }>
  createProposalSet(input: CreateProposalSetInput): Promise<VaultProposalSet>
  approveProposalSet(
    proposalSetId: string,
    reviewerId: string,
    acceptedAt: string
  ): Promise<{ readonly status: "accepted" | "conflict" }>
}

export interface WorkflowStepLike {
  do<Result>(name: string, callback: () => Promise<Result> | Result): Promise<Result>
  waitForEvent?<Result>(
    name: string,
    options: { readonly type: string; readonly timeout: string }
  ): Promise<{ readonly payload: Result }>
}

export interface WorkflowEventLike<Payload> {
  readonly payload: Payload
}

export type CompilerWorkflowResult =
  | {
      readonly workflowId: string
      readonly status: "pending_review"
      readonly proposalId: string
      readonly proposalIds: ReadonlyArray<string>
    }
  | {
      readonly workflowId: string
      readonly status: "published"
      readonly proposalId: string
      readonly proposalIds: ReadonlyArray<string>
    }
  | {
      readonly workflowId: string
      readonly status: "conflict"
      readonly proposalId: string
      readonly proposalIds: ReadonlyArray<string>
    }
  | {
      readonly workflowId: string
      readonly status: "rejected"
      readonly proposalId: string
      readonly proposalIds: ReadonlyArray<string>
    }

export class CompilerWorkflowError extends Error {
  override readonly name = "CompilerWorkflowError"
}

interface CompilerReviewEvent {
  readonly status: "accepted" | "rejected" | "conflict"
}

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?])\s+|\n+/u
const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+.*$/gm
const LIST_MARKER_PATTERN = /^[-*]\s+/

const normalizedWords = (value: string): ReadonlySet<string> =>
  new Set(
    (value.normalize("NFKC").toLocaleLowerCase("en-US").match(WORD_PATTERN) ?? []).filter(
      (word) => word.length > 2
    )
  )

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

export const extractCompilerClaims = (content: string): ReadonlyArray<string> => {
  const claims = content
    .replace(MARKDOWN_HEADING_PATTERN, "")
    .split(SENTENCE_BOUNDARY_PATTERN)
    .map((claim) => claim.replace(LIST_MARKER_PATTERN, "").trim())
    .filter((claim) => claim.length >= 12 && claim.length <= 600)
  return [...new Set(claims)].slice(0, MAX_COMPILER_CLAIMS)
}

const candidateScore = (page: MemoryPage, claims: ReadonlyArray<string>): number => {
  const identityWords = normalizedWords(
    [page.id, page.path, page.title, ...page.aliases, ...page.tags].join(" ")
  )
  const claimWords = normalizedWords(claims.join(" "))
  let score = 0
  for (const word of claimWords) if (identityWords.has(word)) score += 1
  return score
}

export const selectCompilerCandidates = (
  pages: ReadonlyArray<CompilerAcceptedPage>,
  claims: ReadonlyArray<string>
): ReadonlyArray<CompilerAcceptedPage> =>
  [...pages]
    .sort(
      (left, right) =>
        candidateScore(right.page, claims) - candidateScore(left.page, claims) ||
        compareText(left.page.id, right.page.id)
    )
    .slice(0, MAX_COMPILER_CANDIDATES)

const scoreClaimForPage = (claim: string, page: MemoryPage): number => {
  const claimWords = normalizedWords(claim)
  const pageWords = normalizedWords(
    [page.id, page.path, page.title, ...page.aliases, ...page.tags].join(" ")
  )
  let score = 0
  for (const word of claimWords) if (pageWords.has(word)) score += 1
  return score
}

const isSemanticallyMechanical = (
  generated: CompilerGeneratedProposal,
  context: CompilerContext
): boolean => {
  if (generated.changeKind !== "mechanical") return false
  const acceptedById = new Map(context.candidates.map((candidate) => [candidate.page.id, candidate.page]))
  return generated.drafts.every((draft) => {
    const accepted = acceptedById.get(draft.pageId)
    if (accepted === undefined) return false
    const candidate = parseMemoryPage(accepted.path, draft.markdown)
    const citationsWithoutCompilerSource = candidate.citations.filter(
      (citation) => citation.sourceId !== context.source.id
    )
    return (
      candidate.revision === accepted.revision + 1 &&
      canonicalJson({ ...candidate, revision: accepted.revision, citations: citationsWithoutCompilerSource }) ===
        canonicalJson(accepted)
    )
  })
}

export class DeterministicCompilerModel implements CompilerModel {
  async generate(context: CompilerContext): Promise<CompilerGeneratedProposal> {
    if (context.candidates.length === 0) {
      throw new CompilerWorkflowError("the vault has no accepted candidate pages")
    }
    const selected = context.candidates.slice(0, Math.min(MAX_COMPILED_PAGES, context.claims.length))
    const claimsByPage = new Map<string, Array<string>>(selected.map((candidate) => [candidate.page.id, []]))
    for (const claim of context.claims) {
      const ranked = [...selected].sort(
        (left, right) =>
          scoreClaimForPage(claim, right.page) - scoreClaimForPage(claim, left.page) ||
          compareText(left.page.id, right.page.id)
      )
      claimsByPage.get(ranked[0]!.page.id)!.push(claim)
    }

    const citationId = `compiler-${stableContentHash(context.source.id).slice(0, 12)}`
    const drafts = selected.flatMap((candidate): ReadonlyArray<ProposalSetDraft> => {
      const claims = claimsByPage.get(candidate.page.id) ?? []
      if (claims.length === 0) return []
      const existingCitation = candidate.page.citations.find(
        (citation) => citation.sourceId === context.source.id
      )
      const activeCitationId = existingCitation?.id ?? citationId
      const page: MemoryPage = {
        ...candidate.page,
        revision: candidate.page.revision + 1,
        citations:
          existingCitation === undefined
            ? [
                ...candidate.page.citations,
                { id: activeCitationId, sourceId: context.source.id }
              ]
            : candidate.page.citations,
        body: `${candidate.page.body.trimEnd()}\n\n## Compiled learnings\n\n${claims
          .map((claim) => `- ${claim} [@${activeCitationId}]`)
          .join("\n")}\n`
      }
      return [
        {
          pageId: page.id,
          baseRevisionId: candidate.revisionId,
          markdown: serializeMemoryMarkdown(page),
          summary: `Compile ${claims.length} cited claim${claims.length === 1 ? "" : "s"}`
        }
      ]
    })
    if (drafts.length === 0) throw new CompilerWorkflowError("the source produced no page edits")
    return { changeKind: "factual", drafts }
  }
}

const readCompilerContext = async (
  repository: CompilerRepository,
  source: CompilerSource,
  claims: ReadonlyArray<string>
): Promise<CompilerContext> => {
  const [pages, navigation] = await Promise.all([
    repository.listAcceptedPages(),
    repository.readNavigation()
  ])
  const isSchemaPage = ({ page }: CompilerAcceptedPage): boolean =>
    page.tags.includes("schema") || page.metadata.kind === "schema" || page.metadata.schema === true
  const schemaPages = pages.filter(isSchemaPage).map(({ page }) => page)
  const candidates = selectCompilerCandidates(pages.filter((entry) => !isSchemaPage(entry)), claims)
  return {
    source: source.source,
    claims,
    schemaPages,
    candidates,
    indexMarkdown: navigation.indexMarkdown,
    prompt: buildCompilerPrompt({
      source: source.source,
      claims,
      schemaPages,
      candidatePages: candidates.map(({ page }) => page),
      indexMarkdown: navigation.indexMarkdown
    })
  }
}

const compilerResult = (
  input: CompilerWorkflowInput,
  proposalSet: VaultProposalSet,
  status: CompilerWorkflowResult["status"]
): CompilerWorkflowResult => ({
  workflowId: input.workflowId,
  status,
  proposalId: proposalSet.id,
  proposalIds: proposalSet.proposalIds
})

const validatedCompilerSource = async (
  repository: CompilerRepository,
  input: CompilerWorkflowInput
): Promise<CompilerSource> => {
  const stored = await repository.readSource(input.sourceId)
  if (stored.source.id !== input.sourceId) {
    throw new CompilerWorkflowError("source identity changed during compilation")
  }
  if (stored.content.length === 0 || stored.content.length > MAX_COMPILER_SOURCE_CHARACTERS) {
    throw new CompilerWorkflowError("source is empty or exceeds the compiler bound")
  }
  if (findCredentialShapedContent(stored.content).length > 0) {
    throw new CompilerWorkflowError("source contains credential-shaped content")
  }
  return stored
}

const claimsForSource = (source: CompilerSource): ReadonlyArray<string> => {
  const claims = extractCompilerClaims(source.content)
  if (claims.length === 0) throw new CompilerWorkflowError("source contains no bounded claims")
  return claims
}

export const runCompilerWorkflow = async (
  input: CompilerWorkflowInput,
  repository: CompilerRepository,
  step: WorkflowStepLike,
  model: CompilerModel = new DeterministicCompilerModel()
): Promise<CompilerWorkflowResult> => {
  const source = await step.do("01-validate-source", () => validatedCompilerSource(repository, input))
  const claims = await step.do("02-extract-claims", () => claimsForSource(source))
  const context = await step.do("03-read-schema-index-and-candidates", () =>
    readCompilerContext(repository, source, claims)
  )
  const generated = await step.do("04-generate-bounded-proposal", () => model.generate(context))
  const proposalSetId = `proposal:${input.workflowId}`
  const proposalSet = await step.do("05-lint-and-persist-proposal", () =>
    repository.createProposalSet({
      id: proposalSetId,
      workflowId: input.workflowId,
      sourceId: input.sourceId,
      proposedBy: input.requestedBy,
      createdAt: input.createdAt,
      changeKind: generated.changeKind,
      drafts: generated.drafts
    })
  )
  const autoPublish = isConfiguredMechanicalFix(
    generated.changeKind,
    new Set(input.autoPublishFixes ?? [])
  ) && isSemanticallyMechanical(generated, context)
  if (!autoPublish) {
    if (step.waitForEvent !== undefined) {
      const reviewEvent = await step.waitForEvent<CompilerReviewEvent>("06-await-durable-review", {
        type: `review:${proposalSet.id}`,
        timeout: "30 days"
      })
      const review = reviewEvent.payload
      return compilerResult(
        input,
        proposalSet,
        review.status === "accepted"
          ? "published"
          : review.status === "rejected"
            ? "rejected"
            : "conflict"
      )
    }
    return compilerResult(input, proposalSet, "pending_review")
  }
  const approval = await step.do("06-auto-publish-configured-mechanical-fix", () =>
    repository.approveProposalSet(proposalSet.id, "system:memory-compiler", input.createdAt)
  )
  return compilerResult(
    input,
    proposalSet,
    approval.status === "accepted" ? "published" : "conflict"
  )
}

const VaultSource = Schema.Struct({ source: MemorySourceSchema, content: Schema.String })
const VaultPageHeads = Schema.Struct({
  pages: Schema.Array(Schema.Struct({ pageId: Schema.String }))
})
const VaultAcceptedPage = Schema.Struct({
  page: MemoryPageSchema,
  revision: Schema.Struct({ id: Schema.String })
})
const VaultNavigation = Schema.Struct({ indexMarkdown: Schema.String })
const VaultProposalSetSchema = Schema.Struct({
  id: Schema.String,
  workflowId: Schema.String,
  sourceId: Schema.String,
  proposedBy: Schema.String,
  createdAt: Schema.String,
  changeKind: Schema.Literal("factual", "mechanical"),
  proposalIds: Schema.Array(Schema.String),
  status: Schema.Literal("open", "accepted", "rejected", "superseded")
})
const VaultApproval = Schema.Struct({ status: Schema.Literal("accepted", "conflict") })

export class DurableObjectCompilerRepository implements CompilerRepository {
  private readonly client: DurableObjectVaultClient

  constructor(
    namespace: DurableObjectNamespaceLike,
    organizationId: string
  ) {
    this.client = new DurableObjectVaultClient(
      namespace,
      organizationId,
      (message) => new CompilerWorkflowError(message)
    )
  }

  async readSource(sourceId: string): Promise<CompilerSource> {
    return this.client.request(
      `/internal/memory/sources/${encodeURIComponent(sourceId)}`,
      VaultSource,
      {
        requestError: "vault request failed",
        invalidResponse: "vault returned an invalid source"
      }
    )
  }

  async listAcceptedPages(): Promise<ReadonlyArray<CompilerAcceptedPage>> {
    const { pages: heads } = await this.client.request("/internal/memory/pages", VaultPageHeads, {
      requestError: "vault request failed",
      invalidResponse: "vault returned an invalid page list"
    })
    return Promise.all(
      heads.map(async ({ pageId }): Promise<CompilerAcceptedPage> => {
        const value = await this.client.request(
          `/internal/memory/pages/${encodeURIComponent(pageId)}`,
          VaultAcceptedPage,
          {
            requestError: "vault request failed",
            invalidResponse: "vault returned an invalid accepted page"
          }
        )
        return {
          page: value.page,
          revisionId: value.revision.id
        }
      })
    )
  }

  async readNavigation(): Promise<{ readonly indexMarkdown: string }> {
    return this.client.request("/internal/memory/navigation", VaultNavigation, {
      requestError: "vault request failed",
      invalidResponse: "vault returned invalid navigation"
    })
  }

  async createProposalSet(input: CreateProposalSetInput): Promise<VaultProposalSet> {
    return this.client.request("/internal/memory/proposal-sets", VaultProposalSetSchema, {
      init: { method: "POST", body: JSON.stringify(input) },
      requestError: "vault request failed",
      invalidResponse: "vault returned an invalid proposal set"
    })
  }

  async approveProposalSet(
    proposalSetId: string,
    reviewerId: string,
    acceptedAt: string
  ): Promise<{ readonly status: "accepted" | "conflict" }> {
    return this.client.request(
      `/internal/memory/proposal-sets/${encodeURIComponent(proposalSetId)}/approve`,
      VaultApproval,
      {
        init: { method: "POST", body: JSON.stringify({ reviewerId, acceptedAt }) },
        requestError: "vault request failed",
        invalidResponse: "vault returned an invalid approval result"
      }
    )
  }
}

export interface CompilerWorkflowEnv {
  readonly MEMORY_VAULTS: DurableObjectNamespaceLike
}

/** Structurally matches a Cloudflare WorkflowEntrypoint while remaining testable in Node. */
export class MemoryCompilerWorkflow {
  constructor(readonly env: CompilerWorkflowEnv) {}

  run(
    event: WorkflowEventLike<CompilerWorkflowInput>,
    step: WorkflowStepLike
  ): Promise<CompilerWorkflowResult> {
    return runCompilerWorkflow(
      event.payload,
      new DurableObjectCompilerRepository(this.env.MEMORY_VAULTS, event.payload.organizationId),
      step
    )
  }
}

import {
  assertMemoryValid,
  canonicalJson,
  compareText,
  parseMemoryMarkdown,
  parseMemoryPage,
  type MemoryPage,
  type MemoryProposal,
  type MemorySource
} from "@jingler/memory"

export const MAX_PROPOSAL_SET_PAGES = 8
export const NEW_PAGE_BASE_REVISION_ID = "new"

export type ProposalChangeKind = "factual" | "mechanical"
export type ProposalSetStatus = "open" | "accepted" | "rejected" | "superseded"

export interface ProposalSetDraft {
  readonly pageId: string
  readonly baseRevisionId: string
  readonly path?: string
  readonly markdown: string
  readonly summary?: string
}

export interface CreateProposalSetInput {
  readonly id: string
  readonly workflowId: string
  readonly sourceId: string
  readonly proposedBy: string
  readonly createdAt: string
  readonly changeKind: ProposalChangeKind
  readonly drafts: ReadonlyArray<ProposalSetDraft>
}

export interface VaultProposalSet {
  readonly id: string
  readonly workflowId: string
  readonly sourceId: string
  readonly proposedBy: string
  readonly createdAt: string
  readonly changeKind: ProposalChangeKind
  readonly proposalIds: ReadonlyArray<string>
  readonly status: ProposalSetStatus
}

export interface ProposalSetHead {
  readonly pageId: string
  readonly path: string
  readonly revisionId: string
  readonly revision: number
}

export interface PreparedProposalSet {
  readonly set: VaultProposalSet
  readonly proposals: ReadonlyArray<MemoryProposal>
  readonly candidatePages: ReadonlyArray<MemoryPage>
}

export class ProposalSetError extends Error {
  override readonly name = "ProposalSetError"
}

const proposalIdFor = (setId: string, pageId: string): string =>
  `${setId}:page:${encodeURIComponent(pageId)}`

const pageCitesSource = (page: MemoryPage, sourceId: string): boolean =>
  page.citations.some((citation) => citation.sourceId === sourceId)

interface DraftContext {
  readonly sourceId: string
  readonly acceptedById: ReadonlyMap<string, MemoryPage>
  readonly headsById: ReadonlyMap<string, ProposalSetHead>
  readonly seenPages: Set<string>
}

const prepareDraft = (
  set: Pick<CreateProposalSetInput, "id" | "proposedBy" | "createdAt">,
  draft: ProposalSetDraft,
  context: DraftContext
): { readonly proposal: MemoryProposal; readonly candidate: MemoryPage } => {
  if (context.seenPages.has(draft.pageId)) {
    throw new ProposalSetError(`proposal set edits page ${draft.pageId} more than once`)
  }
  context.seenPages.add(draft.pageId)
  const accepted = context.acceptedById.get(draft.pageId)
  const head = context.headsById.get(draft.pageId)
  if (accepted === undefined || head === undefined) {
    if (accepted !== undefined || head !== undefined) {
      throw new ProposalSetError(`proposal page ${draft.pageId} has inconsistent accepted state`)
    }
    if (draft.baseRevisionId !== NEW_PAGE_BASE_REVISION_ID) {
      throw new ProposalSetError(
        `new proposal page ${draft.pageId} must use the ${NEW_PAGE_BASE_REVISION_ID} base`
      )
    }
    const candidate = parseMemoryMarkdown(draft.markdown, draft.path)
    if (candidate.id !== draft.pageId || candidate.revision !== 1) {
      throw new ProposalSetError(`new proposal page ${draft.pageId} must have matching identity and revision 1`)
    }
    if (!pageCitesSource(candidate, context.sourceId)) {
      throw new ProposalSetError(
        `proposal page ${draft.pageId} does not cite compiler source ${context.sourceId}`
      )
    }
    return {
      candidate,
      proposal: {
        id: proposalIdFor(set.id, draft.pageId),
        pageId: draft.pageId,
        baseRevisionId: draft.baseRevisionId,
        path: candidate.path,
        markdown: draft.markdown,
        proposedBy: set.proposedBy,
        createdAt: set.createdAt,
        status: "open",
        ...(draft.summary === undefined ? {} : { summary: draft.summary })
      }
    }
  }
  if (draft.baseRevisionId !== head.revisionId) {
    throw new ProposalSetError(
      `proposal page ${draft.pageId} is based on ${draft.baseRevisionId}, not ${head.revisionId}`
    )
  }
  const candidate = parseMemoryPage(head.path, draft.markdown)
  if (candidate.id !== draft.pageId || candidate.path !== accepted.path) {
    throw new ProposalSetError(`proposal identity does not match page ${draft.pageId}`)
  }
  if (candidate.revision !== head.revision + 1) {
    throw new ProposalSetError(
      `proposal page ${draft.pageId} must advance revision ${head.revision} by exactly one`
    )
  }
  if (!pageCitesSource(candidate, context.sourceId)) {
    throw new ProposalSetError(
      `proposal page ${draft.pageId} does not cite compiler source ${context.sourceId}`
    )
  }
  return {
    candidate,
    proposal: {
      id: proposalIdFor(set.id, draft.pageId),
      pageId: draft.pageId,
      baseRevisionId: draft.baseRevisionId,
      markdown: draft.markdown,
      proposedBy: set.proposedBy,
      createdAt: set.createdAt,
      status: "open",
      ...(draft.summary === undefined ? {} : { summary: draft.summary })
    }
  }
}

export const prepareProposalSet = (
  input: CreateProposalSetInput,
  acceptedPages: ReadonlyArray<MemoryPage>,
  heads: ReadonlyArray<ProposalSetHead>,
  sources: ReadonlyArray<MemorySource>
): PreparedProposalSet => {
  if (input.drafts.length === 0 || input.drafts.length > MAX_PROPOSAL_SET_PAGES) {
    throw new ProposalSetError(
      `proposal set must contain between 1 and ${MAX_PROPOSAL_SET_PAGES} pages`
    )
  }
  if (!sources.some((source) => source.id === input.sourceId)) {
    throw new ProposalSetError(`proposal source ${input.sourceId} does not exist`)
  }

  const acceptedById = new Map(acceptedPages.map((page) => [page.id, page]))
  const headsById = new Map(heads.map((head) => [head.pageId, head]))
  const proposals: Array<MemoryProposal> = []
  const replacements = new Map<string, MemoryPage>()
  const context: DraftContext = {
    sourceId: input.sourceId,
    acceptedById,
    headsById,
    seenPages: new Set()
  }
  for (const draft of input.drafts) {
    const prepared = prepareDraft(input, draft, context)
    replacements.set(prepared.candidate.id, prepared.candidate)
    proposals.push(prepared.proposal)
  }

  const candidatePages = [
    ...acceptedPages.map((page) => replacements.get(page.id) ?? page),
    ...[...replacements.values()].filter((page) => !acceptedById.has(page.id))
  ]
  assertMemoryValid({ pages: candidatePages, sources }, { requireCitations: true })
  const sortedProposals = [...proposals].sort((left, right) => compareText(left.pageId, right.pageId))
  return {
    set: {
      id: input.id,
      workflowId: input.workflowId,
      sourceId: input.sourceId,
      proposedBy: input.proposedBy,
      createdAt: input.createdAt,
      changeKind: input.changeKind,
      proposalIds: sortedProposals.map((proposal) => proposal.id),
      status: "open"
    },
    proposals: sortedProposals,
    candidatePages
  }
}

export const proposalSetMatches = (
  existing: VaultProposalSet,
  proposals: ReadonlyArray<MemoryProposal>,
  prepared: PreparedProposalSet
): boolean =>
  canonicalJson({ ...existing, status: "open" }) === canonicalJson(prepared.set) &&
  canonicalJson(
    proposals
      .filter((proposal) => existing.proposalIds.includes(proposal.id))
      .map((proposal) => ({ ...proposal, status: "open" }))
      .sort((left, right) => compareText(left.id, right.id))
  ) === canonicalJson([...prepared.proposals].sort((left, right) => compareText(left.id, right.id)))

export const isConfiguredMechanicalFix = (
  changeKind: ProposalChangeKind,
  configuredFixes: ReadonlySet<string>
): boolean => changeKind === "mechanical" && configuredFixes.has("canonical-markdown")

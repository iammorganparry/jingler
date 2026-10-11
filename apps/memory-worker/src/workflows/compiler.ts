import {
  MemoryCompilerCandidateResult as MemoryCompilerCandidateResultSchema,
  MemoryPage as MemoryPageSchema,
  MemorySource as MemorySourceSchema,
  canonicalJson,
  compareText,
  findCredentialShapedContent,
  parseMemoryPage,
  serializeMemoryMarkdown,
  stableContentHash,
  type MemoryCompilerCandidate,
  type MemoryCompilerCandidateResult,
  type MemoryCompilerNoLearningReason,
  type MemoryDurabilityReason,
  type MemoryPage,
  type MemoryRelationshipCandidate,
  type MemorySensitivityClass,
  type MemorySource,
} from "@jingler/memory";
import { Schema } from "effect";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  MemoryFunnelTransition as MemoryFunnelTransitionSchema,
  type MemoryCompilerPermanentFailureCode,
  type MemoryFunnelSourceKind,
  type MemoryFunnelTransition,
  type MemoryRolloutAssignment,
  type MemorySourcePublicationPolicy,
} from "@jingler/core";
import { buildCompilerPrompt } from "../compiler-prompt.js";
import type { DurableObjectNamespaceLike } from "../env.js";
import {
  isConfiguredMechanicalFix,
  NEW_PAGE_BASE_REVISION_ID,
  type CreateProposalSetInput,
  type ProposalChangeKind,
  type ProposalSetDraft,
  type VaultProposalSet,
} from "../proposals.js";
import { DurableObjectVaultClient } from "./vault-client.js";

export const MAX_COMPILER_SOURCE_CHARACTERS = 32_000;
export const MAX_COMPILER_CLAIMS = 12;
export const MAX_COMPILER_CANDIDATES = 12;
export const MAX_COMPILED_PAGES = 3;
export const MAX_COMPILER_MATCH_BODY_CHARACTERS = 12_000;
export const MAX_COMPILER_RELATIONSHIP_CANDIDATES = 8;

export interface CompilerWorkflowInput {
  readonly workflowId: string;
  readonly organizationId: string;
  readonly sourceId: string;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly autoPublishFixes?: ReadonlyArray<string>;
  // When true, factual changes wait for a human accept before publishing (safe
  // mechanical fixes still auto-publish). Defaults to false: agents publish
  // straight to the shared vault and are audited/reverted after the fact.
  readonly requireReview?: boolean;
  /** Explicit rollout gate; conversation sources remain review-only unless true. */
  readonly allowSessionAutoPublish?: boolean;
  readonly rollout?: MemoryRolloutAssignment;
  /** Authoritative Worker-side source policy; defaults retain legacy behavior. */
  readonly sourcePublicationPolicy?: MemorySourcePublicationPolicy;
}

export interface CompilerAcceptedPage {
  readonly page: MemoryPage;
  readonly revisionId: string;
}

export interface CompilerSource {
  readonly source: MemorySource;
  readonly content: string;
}

export interface CompilerContext {
  readonly organizationId: string;
  readonly source: MemorySource;
  readonly claims: ReadonlyArray<string>;
  readonly claimEvidence: ReadonlyArray<CompilerClaimEvidence>;
  readonly schemaPages: ReadonlyArray<MemoryPage>;
  readonly candidates: ReadonlyArray<CompilerAcceptedPage>;
  readonly indexMarkdown: string;
}

export interface CompilerModelInput {
  readonly context: CompilerContext;
  /** The constrained model contract; source prose is serialized only as evidence. */
  readonly prompt: string;
}

export interface CompilerGeneratedProposal {
  readonly selection: "create" | "update" | "create_and_update" | "no_op";
  readonly changeKind: ProposalChangeKind;
  readonly drafts: ReadonlyArray<ProposalSetDraft>;
  readonly candidates: ReadonlyArray<MemoryCompilerCandidate>;
  readonly relationshipCandidates: ReadonlyArray<MemoryRelationshipCandidate>;
  readonly noLearningReason?: MemoryCompilerNoLearningReason;
}

export interface CompilerModel {
  generate(input: CompilerModelInput): Promise<unknown>;
}

export interface CompilerRepository {
  readSource(sourceId: string): Promise<CompilerSource>;
  readContext?(
    claims: ReadonlyArray<string>,
    preferredPageId?: string,
  ): Promise<{
    readonly schemaPages: ReadonlyArray<MemoryPage>;
    readonly candidates: ReadonlyArray<CompilerAcceptedPage>;
    readonly indexMarkdown: string;
  }>;
  listAcceptedPages(): Promise<ReadonlyArray<CompilerAcceptedPage>>;
  readNavigation(): Promise<{ readonly indexMarkdown: string }>;
  createProposalSet(input: CreateProposalSetInput): Promise<VaultProposalSet>;
  approveProposalSet(
    proposalSetId: string,
    reviewerId: string,
    acceptedAt: string,
  ): Promise<{ readonly status: "accepted" | "conflict" }>;
  recordTransition?(transition: MemoryFunnelTransition): Promise<void>;
}

export interface WorkflowStepLike {
  do<Result>(
    name: string,
    callback: () => Promise<Result> | Result,
  ): Promise<Result>;
  waitForEvent?<Result>(
    name: string,
    options: { readonly type: string; readonly timeout: string },
  ): Promise<{ readonly payload: Result }>;
}

export interface WorkflowEventLike<Payload> {
  readonly payload: Payload;
}

export type CompilerWorkflowResult =
  | {
      readonly workflowId: string;
      readonly status: "pending_review" | "published" | "conflict" | "rejected";
      readonly proposalId: string;
      readonly proposalIds: ReadonlyArray<string>;
    }
  | {
      readonly workflowId: string;
      readonly sourceId: string;
      readonly status: "no_durable_learning";
      readonly reason:
        "no_bounded_claims" | "already_durable" | "no_page_edits";
    }
  | {
      readonly workflowId: string;
      readonly sourceId: string;
      readonly status: "extraction_shadowed";
      readonly candidateCount: number;
    }
  | {
      readonly workflowId: string;
      readonly sourceId: string;
      readonly status: "permanent_failure";
      readonly code:
        | "invalid_workflow_input"
        | "source_identity_mismatch"
        | "source_content_bounds"
        | "credential_shaped_content"
        | "invalid_proposal"
        | "lint_validation";
      readonly issueCodes: ReadonlyArray<string>;
    };

export class CompilerWorkflowError extends Error {
  override readonly name = "CompilerWorkflowError";

  constructor(
    message: string,
    readonly code?: MemoryCompilerPermanentFailureCode,
    readonly issueCodes: ReadonlyArray<string> = [],
    readonly sourceKind?: MemoryFunnelSourceKind,
  ) {
    super(message);
  }
}

interface CompilerReviewEvent {
  readonly status: "accepted" | "rejected" | "conflict";
}

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;
const CLAIM_SEGMENT_PATTERN = /[^\n]+?(?:[.!?]+(?=\s|$)|(?=\n|$))/gu;
const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+/u;
const LIST_MARKER_PATTERN = /^(?:[-*+]\s+|\d+[.)]\s+)/u;
const DIGEST_LABEL_PATTERN =
  /^(?:user|assistant|system|summary|task|progress|result|tool|analysis)\s*:/iu;
const PROGRESS_NARRATION_PATTERN =
  /^(?:done|completed|implemented|updated|changed|added|fixed|ran|verified)\b|\b(?:i|we)\s+(?:am|are|'m|'re)\s+(?:working|implementing|testing|debugging)|\b(?:next|then)\s+(?:i|we)(?:'ll|\s+will)\b|\b(?:currently|for now|in this turn)\b|\b\d+\s+(?:tests?|files?)\s+passed\b/iu;
const EPHEMERAL_DETAIL_PATTERN =
  /(?:^|\s)(?:\/Users\/|\/home\/|\/tmp\/|\/private\/|[A-Za-z]:\\|\.{0,2}\/)[^\s]+|\bline\s+\d+\b|\b[0-9a-f]{7,40}\b|\b(?:stdout|stderr|stack trace|timestamp)\b/iu;
const CORRECTION_PATTERN =
  /^(?:actually|correction|corrected|update)\b|\b(?:previous|earlier)\s+(?:claim|statement|answer)\b.*\b(?:wrong|incorrect|superseded)|\b(?:is|was|are|were)\s+no\s+longer\b/iu;
const PERSONAL_DATA_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?\d[\s().-]*){8,}|\b(?:ssn|social security|passport|date of birth|dob|home address|lives at)\b/iu;
const SENSITIVE_CATEGORY_PATTERN =
  /\b(?:medical|diagnosis|diagnosed|health condition|disability|race|racial|ethnicity|ethnic|religion|religious|sexual orientation|gender identity|political affiliation|trade union|biometric|genetic|criminal record)\b/iu;
const DURABLE_RELATIONSHIP_PATTERN =
  /\b(?:depends? on|relies? on|relationship between)\b/iu;
const RELATIONSHIP_SUGGESTION_PATTERN =
  /\b(?:depends? on|relies? on|requires?)\b/iu;
const DECISION_REASON_PATTERN = /\bbecause\b/iu;
const DECISION_CUE_PATTERN =
  /\b(?:choose|chose|decision|must|should|use|uses)\b/iu;
const GOTCHA_PATTERN = /\b(?:fails?|breaks?|otherwise|only when|requires?)\b/iu;
const CONVENTION_PATTERN =
  /\b(?:must|should|always|never|default|standard|convention|preserve|uses?)\b/iu;
const VERIFIED_FINDING_PATTERN =
  /\b(?:verified|confirmed|demonstrates?|is|are|has|have)\b/iu;
const LOW_CONFIDENCE_PATTERN =
  /\b(?:maybe|probably|possibly|appears? to|seems? to|likely|inferred?)\b/iu;
const CONTRADICTION_PATTERN =
  /\b(?:not|instead of|contrary|conflicts?|contradicts?)\b/iu;
const PREFERENCE_PATTERN = /\b(?:prefers?|preferences?|favours?|favors?)\b/iu;
const PEOPLE_PROCESS_PATTERN =
  /\b(?:on-call|owner|reviewer|approver|team process|escalat)\b/iu;
const SECURITY_SENSITIVE_PATTERN =
  /\b(?:security|authentication|authorization|permission|vulnerability|encryption)\b/iu;
const OTHER_SENSITIVE_PATTERN = /\b(?:confidential|sensitive|private)\b/iu;
const TRAILING_SENTENCE_PUNCTUATION_PATTERN = /[.!?]+$/u;
const WHITESPACE_PATTERN = /\s+/u;
const PERMANENT_FAILURE_PREFIX = "jingler-memory-permanent:";

const permanentFailureMessage = (
  code: MemoryCompilerPermanentFailureCode,
  issueCodes: ReadonlyArray<string>,
  sourceKind?: MemoryFunnelSourceKind,
): string =>
  `${PERMANENT_FAILURE_PREFIX}${canonicalJson({
    code,
    issueCodes: [...new Set(issueCodes)].sort(),
    ...(sourceKind === undefined ? {} : { sourceKind }),
  })}`;

const permanentFailureFrom = (
  error: unknown,
):
  | {
      readonly code: MemoryCompilerPermanentFailureCode;
      readonly issueCodes: ReadonlyArray<string>;
      readonly sourceKind?: MemoryFunnelSourceKind;
    }
  | undefined => {
  if (
    !(error instanceof Error) ||
    !error.message.startsWith(PERMANENT_FAILURE_PREFIX)
  )
    return;
  try {
    const value: unknown = JSON.parse(
      error.message.slice(PERMANENT_FAILURE_PREFIX.length),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("code" in value) ||
      !("issueCodes" in value)
    )
      return;
    const code = value.code;
    const issueCodes = value.issueCodes;
    const validCodes: ReadonlySet<unknown> = new Set([
      "invalid_workflow_input",
      "source_identity_mismatch",
      "source_content_bounds",
      "credential_shaped_content",
      "invalid_proposal",
      "lint_validation",
    ]);
    if (
      !validCodes.has(code) ||
      !Array.isArray(issueCodes) ||
      !issueCodes.every((item) => typeof item === "string")
    )
      return;
    const sourceKind =
      "sourceKind" in value && typeof value.sourceKind === "string"
        ? (value.sourceKind as MemoryFunnelSourceKind)
        : undefined;
    return {
      code: code as MemoryCompilerPermanentFailureCode,
      issueCodes,
      ...(sourceKind === undefined ? {} : { sourceKind }),
    };
  } catch {
    return;
  }
};

const permanentStep = async <Result>(
  step: WorkflowStepLike,
  name: string,
  callback: () => Promise<Result> | Result,
  sourceKind?: MemoryFunnelSourceKind,
): Promise<Result> =>
  step.do(name, async () => {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof CompilerWorkflowError && error.code !== undefined) {
        throw new NonRetryableError(
          permanentFailureMessage(
            error.code,
            error.issueCodes,
            error.sourceKind ?? sourceKind,
          ),
        );
      }
      throw error;
    }
  });

export interface CompilerPageIdentity {
  readonly pageId: string;
  readonly path: string;
}

/**
 * Compiler-created page identity is scoped by organization and source, never by
 * a display title. Titles are intentionally cosmetic because settled sessions
 * normally share the same generic title.
 */
export const compilerPageIdentity = (
  organizationId: string,
  sourceId: string,
  title: string,
): CompilerPageIdentity => {
  const suffix = stableContentHash(`${organizationId}\u0000${sourceId}`).slice(
    0,
    16,
  );
  const slug =
    title
      .normalize("NFKD")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "learning";
  return {
    pageId: `learning-${suffix}`,
    path: `learnings/${slug}-${suffix}.md`,
  };
};

const normalizedWords = (value: string): ReadonlySet<string> =>
  new Set(
    (
      value.normalize("NFKC").toLocaleLowerCase("en-US").match(WORD_PATTERN) ??
      []
    ).filter((word) => word.length > 2 && !COMPILER_MATCH_STOP_WORDS.has(word)),
  );

const COMPILER_MATCH_STOP_WORDS = new Set([
  "and",
  "are",
  "because",
  "for",
  "from",
  "has",
  "must",
  "not",
  "should",
  "that",
  "the",
  "their",
  "this",
  "uses",
  "was",
  "were",
  "with",
]);

const normalizedProse = (value: string): string =>
  (
    value.normalize("NFKC").toLocaleLowerCase("en-US").match(WORD_PATTERN) ?? []
  ).join(" ");

export const extractCompilerClaims = (
  content: string,
): ReadonlyArray<string> => {
  return extractCompilerClaimEvidence(content).map(({ claim }) => claim);
};

export type CompilerClaimFilterReason =
  | "label"
  | "progress"
  | "ephemeral"
  | "correction"
  | "credential"
  | "personal_data"
  | "sensitive_category"
  | "bounds";

export interface CompilerClaimEvidence {
  readonly claim: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export interface FilteredCompilerClaim {
  readonly reason: CompilerClaimFilterReason;
  readonly quote: string;
}

export interface CompilerClaimExtraction {
  readonly claims: ReadonlyArray<CompilerClaimEvidence>;
  readonly filtered: ReadonlyArray<FilteredCompilerClaim>;
}

const filterReason = (
  claim: string,
  quote: string,
): CompilerClaimFilterReason | undefined => {
  if (claim.length < 12 || claim.length > 600) return "bounds";
  if (DIGEST_LABEL_PATTERN.test(claim)) return "label";
  if (CORRECTION_PATTERN.test(claim)) return "correction";
  if (PROGRESS_NARRATION_PATTERN.test(claim)) return "progress";
  if (EPHEMERAL_DETAIL_PATTERN.test(claim)) return "ephemeral";
  if (findCredentialShapedContent(quote).length > 0) return "credential";
  if (PERSONAL_DATA_PATTERN.test(claim)) return "personal_data";
  if (SENSITIVE_CATEGORY_PATTERN.test(claim)) return "sensitive_category";
};

/** Extracts exact source spans while rejecting transcript-shaped or sensitive prose. */
export const extractCompilerClaimEvidenceWithFilters = (
  content: string,
): CompilerClaimExtraction => {
  const claims: Array<CompilerClaimEvidence> = [];
  const filtered: Array<FilteredCompilerClaim> = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(CLAIM_SEGMENT_PATTERN)) {
    const matched = match[0];
    if (matched === undefined || match.index === undefined) continue;
    const quote = matched.trim();
    if (quote.length === 0) continue;
    const leading = matched.indexOf(quote);
    const start = match.index + leading;
    const isHeading = MARKDOWN_HEADING_PATTERN.test(quote);
    const claim = quote
      .replace(MARKDOWN_HEADING_PATTERN, "")
      .replace(LIST_MARKER_PATTERN, "")
      .trim();
    if (claim.length === 0) continue;
    const reason = isHeading ? "label" : filterReason(claim, quote);
    if (reason !== undefined) {
      filtered.push({ reason, quote });
      if (reason === "correction") claims.pop();
      continue;
    }
    const normalized = claim.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    claims.push({ claim, start, end: start + quote.length, quote });
    if (claims.length >= MAX_COMPILER_CLAIMS) break;
  }
  return { claims, filtered };
};

export const extractCompilerClaimEvidence = (
  content: string,
): ReadonlyArray<CompilerClaimEvidence> =>
  extractCompilerClaimEvidenceWithFilters(content).claims;

const candidateScore = (
  page: MemoryPage,
  claims: ReadonlyArray<string>,
): number => {
  const identityWords = normalizedWords(
    [page.id, page.path, page.title, ...page.aliases, ...page.tags].join(" "),
  );
  const boundedBody = page.body.slice(0, MAX_COMPILER_MATCH_BODY_CHARACTERS);
  const bodyWords = normalizedWords(boundedBody);
  const normalizedBody = normalizedProse(boundedBody);
  return claims.reduce((total, claim) => {
    const claimWords = normalizedWords(claim);
    if (claimWords.size === 0) return total;
    let identityOverlap = 0;
    let bodyOverlap = 0;
    for (const word of claimWords) {
      if (identityWords.has(word)) identityOverlap += 1;
      if (bodyWords.has(word)) bodyOverlap += 1;
    }
    const requiredOverlap = claimWords.size <= 3 ? 1 : 2;
    const hasBodyEvidence =
      bodyOverlap >= requiredOverlap ||
      normalizedBody.includes(normalizedProse(claim));
    if (!hasBodyEvidence && identityOverlap === 0) return total;
    return (
      total + identityOverlap * 3 + bodyOverlap * 2 + (hasBodyEvidence ? 4 : 0)
    );
  }, 0);
};

export const selectCompilerCandidates = (
  pages: ReadonlyArray<CompilerAcceptedPage>,
  claims: ReadonlyArray<string>,
): ReadonlyArray<CompilerAcceptedPage> =>
  [...pages]
    .filter((entry) => candidateScore(entry.page, claims) > 0)
    .sort(
      (left, right) =>
        candidateScore(right.page, claims) -
          candidateScore(left.page, claims) ||
        compareText(left.page.id, right.page.id),
    )
    .slice(0, MAX_COMPILER_CANDIDATES);

const scoreClaimForPage = (claim: string, page: MemoryPage): number => {
  const claimWords = normalizedWords(claim);
  const identityWords = normalizedWords(
    [page.id, page.path, page.title, ...page.aliases, ...page.tags].join(" "),
  );
  const boundedBody = page.body.slice(0, MAX_COMPILER_MATCH_BODY_CHARACTERS);
  const bodyWords = normalizedWords(boundedBody);
  let identityOverlap = 0;
  let bodyOverlap = 0;
  for (const word of claimWords) {
    if (identityWords.has(word)) identityOverlap += 1;
    if (bodyWords.has(word)) bodyOverlap += 1;
  }
  const requiredOverlap = claimWords.size <= 3 ? 1 : 2;
  const hasBodyEvidence =
    bodyOverlap >= requiredOverlap ||
    normalizedProse(boundedBody).includes(normalizedProse(claim));
  const hasIdentityEvidence = identityOverlap >= requiredOverlap;
  return hasBodyEvidence || hasIdentityEvidence
    ? (hasBodyEvidence ? 4 : 0) + bodyOverlap * 2 + identityOverlap * 3
    : 0;
};

const pageContainsClaim = (page: MemoryPage, claim: string): boolean =>
  normalizedProse(
    page.body.slice(0, MAX_COMPILER_MATCH_BODY_CHARACTERS),
  ).includes(normalizedProse(claim));

const isSemanticallyMechanical = (
  generated: CompilerGeneratedProposal,
  context: CompilerContext,
): boolean => {
  if (generated.changeKind !== "mechanical") return false;
  const acceptedById = new Map(
    context.candidates.map((candidate) => [candidate.page.id, candidate.page]),
  );
  return generated.drafts.every((draft) => {
    const accepted = acceptedById.get(draft.pageId);
    if (accepted === undefined) return false;
    const candidate = parseMemoryPage(accepted.path, draft.markdown);
    const citationsWithoutCompilerSource = candidate.citations.filter(
      (citation) => citation.sourceId !== context.source.id,
    );
    return (
      candidate.revision === accepted.revision + 1 &&
      canonicalJson({
        ...candidate,
        revision: accepted.revision,
        citations: citationsWithoutCompilerSource,
      }) === canonicalJson(accepted)
    );
  });
};

const durableReasonForClaim = (
  claim: string,
): MemoryDurabilityReason | undefined => {
  if (DURABLE_RELATIONSHIP_PATTERN.test(claim)) return "durable_relationship";
  if (DECISION_REASON_PATTERN.test(claim) && DECISION_CUE_PATTERN.test(claim)) {
    return "decision_with_reason";
  }
  if (GOTCHA_PATTERN.test(claim)) return "reusable_gotcha";
  if (CONVENTION_PATTERN.test(claim)) {
    return "stable_convention";
  }
  if (VERIFIED_FINDING_PATTERN.test(claim)) return "verified_finding";
};

const sensitivityForClaim = (claim: string): MemorySensitivityClass => {
  if (LOW_CONFIDENCE_PATTERN.test(claim) || CONTRADICTION_PATTERN.test(claim))
    return "other_sensitive";
  if (PREFERENCE_PATTERN.test(claim)) return "preference";
  if (PEOPLE_PROCESS_PATTERN.test(claim)) return "people_process";
  if (SECURITY_SENSITIVE_PATTERN.test(claim)) return "security_sensitive";
  if (OTHER_SENSITIVE_PATTERN.test(claim)) return "other_sensitive";
  return "standard";
};

const titleForClaim = (claim: string): string => {
  const words = claim
    .replace(TRAILING_SENTENCE_PUNCTUATION_PATTERN, "")
    .split(WHITESPACE_PATTERN)
    .filter((word) => word.length > 0)
    .slice(0, 9);
  const title = words.join(" ").slice(0, 96).trim();
  return title || "Durable learning";
};

const relationshipSuggestionsFor = (
  claim: string,
  targetPageId: string,
  candidates: ReadonlyArray<CompilerAcceptedPage>,
): MemoryCompilerCandidate["relationshipSuggestions"] => {
  if (!RELATIONSHIP_SUGGESTION_PATTERN.test(claim)) return [];
  const normalizedClaim = normalizedProse(claim);
  return candidates.flatMap(({ page }) => {
    if (page.id === targetPageId) return [];
    const identities = [page.title, ...page.aliases]
      .map(normalizedProse)
      .filter((identity) => identity.length >= 4);
    return identities.some((identity) => normalizedClaim.includes(identity))
      ? [{ kind: "dependency" as const, target: page.id }]
      : [];
  });
};

/** Deterministic policy implementation; it emits data, never page-shaped Markdown. */
export class DeterministicCompilerModel implements CompilerModel {
  async generate({
    context,
  }: CompilerModelInput): Promise<MemoryCompilerCandidateResult> {
    const ownedPageId = compilerPageIdentity(
      context.organizationId,
      context.source.id,
      context.source.title,
    ).pageId;
    const owned = context.candidates.find(
      (candidate) => candidate.page.id === ownedPageId,
    );
    const defaultTitle = titleForClaim(
      context.claimEvidence[0]?.claim ?? context.source.title,
    );
    const createTarget = {
      action: "create" as const,
      ...compilerPageIdentity(
        context.organizationId,
        context.source.id,
        defaultTitle,
      ),
      title: defaultTitle,
    };
    const candidates: Array<MemoryCompilerCandidate> = [];
    for (const evidence of context.claimEvidence) {
      if (
        context.candidates.some((candidate) =>
          pageContainsClaim(candidate.page, evidence.claim),
        )
      )
        continue;
      const durabilityReason = durableReasonForClaim(evidence.claim);
      if (durabilityReason === undefined) continue;
      const ranked = [...context.candidates].sort(
        (left, right) =>
          scoreClaimForPage(evidence.claim, right.page) -
            scoreClaimForPage(evidence.claim, left.page) ||
          compareText(left.page.id, right.page.id),
      );
      const best =
        owned ??
        ranked.find(
          (candidate) => scoreClaimForPage(evidence.claim, candidate.page) > 0,
        );
      const targetIdentity =
        best === undefined
          ? createTarget
          : {
              action: "update" as const,
              pageId: best.page.id,
              revisionId: best.revisionId,
            };
      candidates.push({
        claim: evidence.claim,
        evidence: {
          sourceId: context.source.id,
          start: evidence.start,
          end: evidence.end,
          quote: evidence.quote,
        },
        durabilityReason,
        sensitivity: sensitivityForClaim(evidence.claim),
        targetIdentity,
        relationshipSuggestions: relationshipSuggestionsFor(
          evidence.claim,
          targetIdentity.pageId,
          context.candidates,
        ),
      });
      if (candidates.length >= MAX_COMPILED_PAGES) break;
    }
    if (candidates.length > 0) return { status: "candidates", candidates };
    const alreadyDurable = context.claimEvidence.some((evidence) =>
      context.candidates.some((candidate) =>
        pageContainsClaim(candidate.page, evidence.claim),
      ),
    );
    return {
      status: "no_durable_learning",
      reason: alreadyDurable ? "already_durable" : "model_declined",
      candidates: [],
    };
  }
}

const sameEvidence = (
  candidate: MemoryCompilerCandidate,
  context: CompilerContext,
): boolean =>
  candidate.evidence.sourceId === context.source.id &&
  context.claimEvidence.some(
    (evidence) =>
      evidence.claim === candidate.claim &&
      evidence.start === candidate.evidence.start &&
      evidence.end === candidate.evidence.end &&
      evidence.quote === candidate.evidence.quote,
  );

/** Build bounded review records without turning advisory similarity into edges. */
export const relationshipCandidatesForCompiler = (
  candidates: ReadonlyArray<MemoryCompilerCandidate>,
  acceptedPages: ReadonlyArray<CompilerAcceptedPage>,
  proposedBy: string,
  createdAt: string,
): ReadonlyArray<MemoryRelationshipCandidate> => {
  const acceptedIds = new Set(acceptedPages.map(({ page }) => page.id));
  const output = new Map<string, MemoryRelationshipCandidate>();
  for (const candidate of candidates) {
    if (candidate.targetIdentity.action !== "update") continue;
    const sourcePageId = candidate.targetIdentity.pageId;
    if (!acceptedIds.has(sourcePageId)) continue;
    for (const suggestion of candidate.relationshipSuggestions) {
      if (
        !acceptedIds.has(suggestion.target) ||
        suggestion.target === sourcePageId
      )
        continue;
      const key = canonicalJson({
        kind: suggestion.kind,
        sourcePageId,
        targetPageId: suggestion.target,
        compilerEvidence: candidate.evidence,
      });
      const id = `relationship:${stableContentHash(key)}`;
      if (output.has(id)) continue;
      output.set(id, {
        id,
        kind: suggestion.kind,
        sourcePageId,
        targetPageId: suggestion.target,
        claim: candidate.claim,
        compilerEvidence: candidate.evidence,
        proposedBy,
        createdAt,
        status: "open",
      });
      if (output.size >= MAX_COMPILER_RELATIONSHIP_CANDIDATES)
        return [...output.values()];
    }
  }
  return [...output.values()];
};

const materializeCandidateResult = (
  context: CompilerContext,
  result: MemoryCompilerCandidateResult,
  proposedBy: string,
  createdAt: string,
): CompilerGeneratedProposal => {
  if (result.status === "no_durable_learning") {
    return {
      selection: "no_op",
      changeKind: "factual",
      drafts: [],
      candidates: [],
      relationshipCandidates: [],
      noLearningReason: result.reason,
    };
  }
  const acceptedById = new Map(
    context.candidates.map((candidate) => [candidate.page.id, candidate]),
  );
  const allowedRelationshipTargets = new Set(
    context.candidates.map((candidate) => candidate.page.id),
  );
  for (const candidate of result.candidates) {
    if (!sameEvidence(candidate, context)) {
      throw new CompilerWorkflowError(
        "compiler candidate does not match extracted evidence",
        "invalid_proposal",
      );
    }
    if (candidate.targetIdentity.action === "update") {
      const accepted = acceptedById.get(candidate.targetIdentity.pageId);
      if (
        accepted === undefined ||
        accepted.revisionId !== candidate.targetIdentity.revisionId
      ) {
        throw new CompilerWorkflowError(
          "compiler candidate targets an unknown accepted revision",
          "invalid_proposal",
        );
      }
    } else {
      const expected = compilerPageIdentity(
        context.organizationId,
        context.source.id,
        candidate.targetIdentity.title,
      );
      if (
        expected.pageId !== candidate.targetIdentity.pageId ||
        expected.path !== candidate.targetIdentity.path
      ) {
        throw new CompilerWorkflowError(
          "compiler candidate uses a non-deterministic new-page identity",
          "invalid_proposal",
        );
      }
    }
    for (const relationship of candidate.relationshipSuggestions) {
      if (!allowedRelationshipTargets.has(relationship.target)) {
        throw new CompilerWorkflowError(
          "compiler suggested an unknown accepted-page relationship target",
          "invalid_proposal",
        );
      }
    }
  }

  const byTarget = new Map<string, Array<MemoryCompilerCandidate>>();
  for (const candidate of result.candidates) {
    const group = byTarget.get(candidate.targetIdentity.pageId) ?? [];
    group.push(candidate);
    byTarget.set(candidate.targetIdentity.pageId, group);
  }
  const citationId = `compiler-${stableContentHash(context.source.id).slice(0, 12)}`;
  const drafts = [...byTarget.values()].map((candidates): ProposalSetDraft => {
    const target = candidates[0]!.targetIdentity;
    if (
      candidates.some(
        (candidate) =>
          canonicalJson(candidate.targetIdentity) !== canonicalJson(target),
      )
    ) {
      throw new CompilerWorkflowError(
        "compiler candidates disagree on one page identity",
        "invalid_proposal",
      );
    }
    const claimLines = [
      ...new Set(candidates.map((candidate) => candidate.claim)),
    ];
    if (target.action === "update") {
      const accepted = acceptedById.get(target.pageId)!;
      const existingCitation = accepted.page.citations.find(
        (citation) => citation.sourceId === context.source.id,
      );
      const activeCitationId = existingCitation?.id ?? citationId;
      const page: MemoryPage = {
        ...accepted.page,
        revision: accepted.page.revision + 1,
        citations:
          existingCitation === undefined
            ? [
                ...accepted.page.citations,
                { id: activeCitationId, sourceId: context.source.id },
              ]
            : accepted.page.citations,
        relationships: accepted.page.relationships,
        body: `${accepted.page.body.trimEnd()}\n\n## Durable learnings\n\n${claimLines
          .map((claim) => `- ${claim} [@${activeCitationId}]`)
          .join("\n")}\n`,
      };
      return {
        pageId: page.id,
        baseRevisionId: accepted.revisionId,
        markdown: serializeMemoryMarkdown(page),
        summary: `Add ${claimLines.length} structured durable claim${claimLines.length === 1 ? "" : "s"}`,
      };
    }
    const page: MemoryPage = {
      id: target.pageId,
      path: target.path,
      title: target.title,
      revision: 1,
      aliases: [],
      tags: ["durable-learning"],
      sources: [],
      citations: [{ id: citationId, sourceId: context.source.id }],
      relationships: [],
      body: `# ${target.title}\n\n${claimLines.map((claim) => `- ${claim} [@${citationId}]`).join("\n")}\n`,
      metadata: {
        compilerCandidateFormat: 1,
        compilerIdentityVersion: 1,
        compilerSourceId: context.source.id,
      },
    };
    return {
      pageId: page.id,
      path: page.path,
      baseRevisionId: NEW_PAGE_BASE_REVISION_ID,
      markdown: serializeMemoryMarkdown(page),
      summary: `Create ${claimLines.length} structured durable claim${claimLines.length === 1 ? "" : "s"}`,
    };
  });
  const creates = result.candidates.some(
    (candidate) => candidate.targetIdentity.action === "create",
  );
  const updates = result.candidates.some(
    (candidate) => candidate.targetIdentity.action === "update",
  );
  return {
    selection:
      creates && updates ? "create_and_update" : creates ? "create" : "update",
    changeKind: "factual",
    drafts,
    candidates: result.candidates,
    relationshipCandidates: relationshipCandidatesForCompiler(
      result.candidates,
      context.candidates,
      proposedBy,
      createdAt,
    ),
  };
};

const readCompilerContext = async (
  repository: CompilerRepository,
  input: CompilerWorkflowInput,
  source: CompilerSource,
  claimEvidence: ReadonlyArray<CompilerClaimEvidence>,
): Promise<CompilerContext> => {
  const claims = claimEvidence.map(({ claim }) => claim);
  const preferredPageId = compilerPageIdentity(
    input.organizationId,
    source.source.id,
    source.source.title,
  ).pageId;
  const bounded = await repository.readContext?.(claims, preferredPageId);
  const [pages, navigation] =
    bounded === undefined
      ? await Promise.all([
          repository.listAcceptedPages(),
          repository.readNavigation(),
        ])
      : [bounded.candidates, { indexMarkdown: bounded.indexMarkdown }];
  const isSchemaPage = ({ page }: CompilerAcceptedPage): boolean =>
    page.tags.includes("schema") ||
    page.metadata.kind === "schema" ||
    page.metadata.schema === true;
  const schemaPages =
    bounded?.schemaPages ?? pages.filter(isSchemaPage).map(({ page }) => page);
  const nonSchemaPages = pages.filter((entry) => !isSchemaPage(entry));
  const preferred = nonSchemaPages.find(
    (entry) => entry.page.id === preferredPageId,
  );
  const candidates = [
    ...(preferred === undefined ? [] : [preferred]),
    ...selectCompilerCandidates(nonSchemaPages, claims).filter(
      (entry) => entry.page.id !== preferredPageId,
    ),
  ].slice(0, MAX_COMPILER_CANDIDATES);
  return {
    organizationId: input.organizationId,
    source: source.source,
    claims,
    claimEvidence,
    schemaPages,
    candidates,
    indexMarkdown: navigation.indexMarkdown,
  };
};

const compilerResult = (
  input: CompilerWorkflowInput,
  proposalSet: VaultProposalSet,
  status: "pending_review" | "published" | "conflict" | "rejected",
): CompilerWorkflowResult => ({
  workflowId: input.workflowId,
  status,
  proposalId: proposalSet.id,
  proposalIds: [
    ...proposalSet.proposalIds,
    ...proposalSet.relationshipCandidates.map(
      (relationship) => relationship.id,
    ),
  ],
});

const validatedCompilerSource = async (
  repository: CompilerRepository,
  input: CompilerWorkflowInput,
): Promise<CompilerSource> => {
  const stored = await repository.readSource(input.sourceId);
  if (stored.source.id !== input.sourceId) {
    throw new CompilerWorkflowError(
      "source identity changed during compilation",
      "source_identity_mismatch",
      [],
      stored.source.kind,
    );
  }
  if (
    stored.content.length === 0 ||
    stored.content.length > MAX_COMPILER_SOURCE_CHARACTERS
  ) {
    throw new CompilerWorkflowError(
      "source is empty or exceeds the compiler bound",
      "source_content_bounds",
      [],
      stored.source.kind,
    );
  }
  return stored;
};

const claimsForSource = (
  source: CompilerSource,
): ReadonlyArray<CompilerClaimEvidence> =>
  extractCompilerClaimEvidence(source.content);

const noDurableLearning = (
  input: CompilerWorkflowInput,
  reason: "no_bounded_claims" | "already_durable" | "no_page_edits",
): CompilerWorkflowResult => ({
  workflowId: input.workflowId,
  sourceId: input.sourceId,
  status: "no_durable_learning",
  reason,
});

const recordCompilerTransition = async (
  repository: CompilerRepository,
  step: WorkflowStepLike,
  name: string,
  transition: MemoryFunnelTransition,
): Promise<void> => {
  if (repository.recordTransition === undefined) return;
  await step.do(name, () => repository.recordTransition!(transition));
};

const runCompilerWorkflowSteps = async (
  input: CompilerWorkflowInput,
  repository: CompilerRepository,
  step: WorkflowStepLike,
  model: CompilerModel = new DeterministicCompilerModel(),
): Promise<CompilerWorkflowResult> => {
  const source = await permanentStep(step, "01-validate-source", () =>
    validatedCompilerSource(repository, input),
  );
  await recordCompilerTransition(
    repository,
    step,
    "01b-record-compilation-started",
    {
      id: `funnel:${input.workflowId}:compilation-started`,
      occurredAt: input.createdAt,
      stage: "compilation",
      outcome: "compilation_started",
      sourceId: input.sourceId,
      sourceKind: source.source.kind,
      ...(input.rollout === undefined ? {} : { rollout: input.rollout }),
      workflowId: input.workflowId,
    },
  );
  const claimEvidence = await step.do("02-extract-claims", () =>
    claimsForSource(source),
  );
  if (claimEvidence.length === 0) {
    await recordCompilerTransition(
      repository,
      step,
      "02b-record-no-bounded-claims",
      {
        id: `funnel:${input.workflowId}:no-durable-learning`,
        occurredAt: input.createdAt,
        stage: "compilation",
        outcome: "no_durable_learning",
        sourceId: input.sourceId,
        sourceKind: source.source.kind,
        ...(input.rollout === undefined ? {} : { rollout: input.rollout }),
        workflowId: input.workflowId,
      },
    );
    return noDurableLearning(input, "no_bounded_claims");
  }
  const context = await step.do("03-read-schema-index-and-candidates", () =>
    readCompilerContext(repository, input, source, claimEvidence),
  );
  const prompt = buildCompilerPrompt({
    source: source.source,
    claims: context.claimEvidence,
    createTarget: (() => {
      const title = titleForClaim(
        context.claimEvidence[0]?.claim ?? context.source.title,
      );
      return {
        action: "create" as const,
        ...compilerPageIdentity(
          context.organizationId,
          context.source.id,
          title,
        ),
        title,
      };
    })(),
    schemaPages: context.schemaPages,
    candidatePages: context.candidates,
    indexMarkdown: context.indexMarkdown,
  });
  const rawCandidateResult = await step.do(
    "04-generate-structured-candidates",
    () => model.generate({ context, prompt }),
  );
  const generated = await permanentStep(
    step,
    "04b-validate-and-materialize-candidates",
    () => {
      try {
        return materializeCandidateResult(
          context,
          Schema.decodeUnknownSync(MemoryCompilerCandidateResultSchema)(
            rawCandidateResult,
          ),
          input.requestedBy,
          input.createdAt,
        );
      } catch (error) {
        if (error instanceof CompilerWorkflowError) throw error;
        throw new CompilerWorkflowError(
          "compiler returned an invalid structured result",
          "invalid_proposal",
        );
      }
    },
    source.source.kind,
  );
  if (generated.selection === "no_op" || generated.drafts.length === 0) {
    await recordCompilerTransition(
      repository,
      step,
      "04b-record-no-page-edits",
      {
        id: `funnel:${input.workflowId}:no-durable-learning`,
        occurredAt: input.createdAt,
        stage: "compilation",
        outcome: "no_durable_learning",
        sourceId: input.sourceId,
        sourceKind: source.source.kind,
        ...(input.rollout === undefined ? {} : { rollout: input.rollout }),
        workflowId: input.workflowId,
      },
    );
    return noDurableLearning(
      input,
      generated.noLearningReason === "already_durable"
        ? "already_durable"
        : generated.noLearningReason === "no_bounded_claims"
          ? "no_bounded_claims"
          : "no_page_edits",
    );
  }
  if (input.rollout?.arms.includes("extraction_shadow") === true) {
    await recordCompilerTransition(
      repository,
      step,
      "04c-record-shadow-extraction",
      {
        id: `funnel:${input.workflowId}:extraction-shadowed`,
        occurredAt: input.createdAt,
        stage: "compilation",
        outcome: "extraction_shadowed",
        sourceId: input.sourceId,
        sourceKind: source.source.kind,
        rollout: input.rollout,
        workflowId: input.workflowId,
      },
    );
    return {
      workflowId: input.workflowId,
      sourceId: input.sourceId,
      status: "extraction_shadowed",
      candidateCount: generated.candidates.length,
    };
  }
  const proposalSetId = `proposal:${input.workflowId}`;
  const relationshipCandidates =
    input.rollout === undefined ||
    input.rollout.arms.includes("relationship_review")
      ? generated.relationshipCandidates
      : [];
  const proposalSet = await permanentStep(
    step,
    "05-lint-and-persist-proposal",
    () =>
      repository.createProposalSet({
        id: proposalSetId,
        workflowId: input.workflowId,
        sourceId: input.sourceId,
        proposedBy: input.requestedBy,
        createdAt: input.createdAt,
        changeKind: generated.changeKind,
        drafts: generated.drafts,
        relationshipCandidates,
      }),
    source.source.kind,
  );
  const autoPublishMechanical =
    isConfiguredMechanicalFix(
      generated.changeKind,
      new Set(input.autoPublishFixes ?? []),
    ) && isSemanticallyMechanical(generated, context);
  const configuredPublicationMode =
    input.sourcePublicationPolicy?.[source.source.kind];
  const autoPublicationAllocated =
    input.rollout?.arms.includes("auto_publication") === true;
  const sessionReviewRequired =
    source.source.kind === "conversation" &&
    !(
      input.allowSessionAutoPublish === true &&
      configuredPublicationMode !== "review" &&
      configuredPublicationMode !== "disabled" &&
      (input.rollout === undefined || autoPublicationAllocated)
    );
  const sourcePolicyReviewRequired =
    configuredPublicationMode === "review" ||
    configuredPublicationMode === "disabled";
  const sensitivityReviewRequired = generated.candidates.some(
    (candidate) => candidate.sensitivity !== "standard",
  );
  // Source-kind and sensitivity gates cannot be bypassed by mechanical-fix
  // configuration. The global review setting may still allow a proven
  // mechanically equivalent non-session change through.
  const autoPublish =
    !(
      sessionReviewRequired ||
      sourcePolicyReviewRequired ||
      sensitivityReviewRequired
    ) &&
    (input.requireReview !== true || autoPublishMechanical);
  if (!autoPublish) {
    await recordCompilerTransition(
      repository,
      step,
      "05b-record-pending-review",
      {
        id: `funnel:${input.workflowId}:pending-review`,
        occurredAt: input.createdAt,
        stage: "review",
        outcome: "pending_review",
        sourceId: input.sourceId,
        sourceKind: source.source.kind,
        ...(input.rollout === undefined ? {} : { rollout: input.rollout }),
        workflowId: input.workflowId,
        proposalSetId: proposalSet.id,
      },
    );
    if (step.waitForEvent !== undefined) {
      const reviewEvent = await step.waitForEvent<CompilerReviewEvent>(
        "06-await-durable-review",
        {
          type: `review:${proposalSet.id}`,
          timeout: "30 days",
        },
      );
      const review = reviewEvent.payload;
      if (
        review.status === "accepted" &&
        proposalSet.relationshipCandidates.length > 0
      ) {
        return compilerResult(input, proposalSet, "pending_review");
      }
      return compilerResult(
        input,
        proposalSet,
        review.status === "accepted"
          ? "published"
          : review.status === "rejected"
            ? "rejected"
            : "conflict",
      );
    }
    return compilerResult(input, proposalSet, "pending_review");
  }
  const approval = await step.do("06-auto-publish", () =>
    repository.approveProposalSet(
      proposalSet.id,
      "system:memory-compiler",
      input.createdAt,
    ),
  );
  if (
    approval.status === "accepted" &&
    proposalSet.relationshipCandidates.length > 0
  ) {
    return compilerResult(input, proposalSet, "pending_review");
  }
  return compilerResult(
    input,
    proposalSet,
    approval.status === "accepted" ? "published" : "conflict",
  );
};

export const runCompilerWorkflow = async (
  input: CompilerWorkflowInput,
  repository: CompilerRepository,
  step: WorkflowStepLike,
  model: CompilerModel = new DeterministicCompilerModel(),
): Promise<CompilerWorkflowResult> => {
  try {
    return await runCompilerWorkflowSteps(input, repository, step, model);
  } catch (error) {
    const failure = permanentFailureFrom(error);
    if (failure === undefined) throw error;
    await recordCompilerTransition(
      repository,
      step,
      "99-record-permanent-failure",
      {
        id: `funnel:${input.workflowId}:permanent-failure`,
        occurredAt: input.createdAt,
        stage: "compilation",
        outcome: "permanent_failure",
        sourceId: input.sourceId,
        sourceKind: failure.sourceKind ?? "other",
        ...(input.rollout === undefined ? {} : { rollout: input.rollout }),
        workflowId: input.workflowId,
        failureCode: failure.code,
      },
    );
    return {
      workflowId: input.workflowId,
      sourceId: input.sourceId,
      status: "permanent_failure",
      code: failure.code,
      issueCodes: failure.issueCodes,
    };
  }
};

const VaultSource = Schema.Struct({
  source: MemorySourceSchema,
  content: Schema.String,
});
const VaultPageHeads = Schema.Struct({
  pages: Schema.Array(Schema.Struct({ pageId: Schema.String })),
});
const VaultAcceptedPage = Schema.Struct({
  page: MemoryPageSchema,
  revision: Schema.Struct({ id: Schema.String }),
});
const VaultNavigation = Schema.Struct({ indexMarkdown: Schema.String });
const VaultCompilerContext = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({ page: MemoryPageSchema, revisionId: Schema.String }),
  ),
  schemaPages: Schema.Array(MemoryPageSchema),
  indexMarkdown: Schema.String,
});
const VaultProposalSetSchema = Schema.Struct({
  id: Schema.String,
  workflowId: Schema.String,
  sourceId: Schema.String,
  proposedBy: Schema.String,
  createdAt: Schema.String,
  changeKind: Schema.Literal("factual", "mechanical"),
  proposalIds: Schema.Array(Schema.String),
  relationshipCandidates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literal("wikilink", "dependency"),
      sourcePageId: Schema.String,
      targetPageId: Schema.String,
      claim: Schema.String,
      compilerEvidence: Schema.Struct({
        sourceId: Schema.String,
        start: Schema.Number,
        end: Schema.Number,
        quote: Schema.String,
      }),
      proposedBy: Schema.String,
      createdAt: Schema.String,
      status: Schema.Literal("open", "accepted", "rejected", "superseded"),
      reviewedBy: Schema.optional(Schema.String),
      reviewedAt: Schema.optional(Schema.String),
    }),
  ),
  status: Schema.Literal("open", "accepted", "rejected", "superseded"),
});
const VaultApproval = Schema.Struct({
  status: Schema.Literal("accepted", "conflict"),
});

export class DurableObjectCompilerRepository implements CompilerRepository {
  private readonly client: DurableObjectVaultClient;

  constructor(namespace: DurableObjectNamespaceLike, organizationId: string) {
    this.client = new DurableObjectVaultClient(
      namespace,
      organizationId,
      (message, failure) =>
        new CompilerWorkflowError(
          message,
          failure?.code === "lint_validation" ||
            failure?.code === "invalid_proposal"
            ? failure.code
            : undefined,
          failure?.issueCodes ?? [],
        ),
    );
  }

  async readSource(sourceId: string): Promise<CompilerSource> {
    return this.client.request(
      `/internal/memory/sources/${encodeURIComponent(sourceId)}`,
      VaultSource,
      {
        requestError: "vault request failed",
        invalidResponse: "vault returned an invalid source",
      },
    );
  }

  async readContext(
    claims: ReadonlyArray<string>,
    preferredPageId?: string,
  ): Promise<{
    readonly schemaPages: ReadonlyArray<MemoryPage>;
    readonly candidates: ReadonlyArray<CompilerAcceptedPage>;
    readonly indexMarkdown: string;
  }> {
    return this.client.request(
      "/internal/memory/compiler-context",
      VaultCompilerContext,
      {
        init: {
          method: "POST",
          body: JSON.stringify({
            claims,
            ...(preferredPageId === undefined ? {} : { preferredPageId }),
          }),
        },
        requestError: "vault context request failed",
        invalidResponse: "vault returned invalid compiler context",
      },
    );
  }

  async listAcceptedPages(): Promise<ReadonlyArray<CompilerAcceptedPage>> {
    const { pages: heads } = await this.client.request(
      "/internal/memory/pages",
      VaultPageHeads,
      {
        requestError: "vault request failed",
        invalidResponse: "vault returned an invalid page list",
      },
    );
    return Promise.all(
      heads.map(async ({ pageId }): Promise<CompilerAcceptedPage> => {
        const value = await this.client.request(
          `/internal/memory/pages/${encodeURIComponent(pageId)}`,
          VaultAcceptedPage,
          {
            requestError: "vault request failed",
            invalidResponse: "vault returned an invalid accepted page",
          },
        );
        return {
          page: value.page,
          revisionId: value.revision.id,
        };
      }),
    );
  }

  async readNavigation(): Promise<{ readonly indexMarkdown: string }> {
    return this.client.request("/internal/memory/navigation", VaultNavigation, {
      requestError: "vault request failed",
      invalidResponse: "vault returned invalid navigation",
    });
  }

  async createProposalSet(
    input: CreateProposalSetInput,
  ): Promise<VaultProposalSet> {
    return this.client.request(
      "/internal/memory/proposal-sets",
      VaultProposalSetSchema,
      {
        init: { method: "POST", body: JSON.stringify(input) },
        requestError: "vault request failed",
        invalidResponse: "vault returned an invalid proposal set",
      },
    );
  }

  async approveProposalSet(
    proposalSetId: string,
    reviewerId: string,
    acceptedAt: string,
  ): Promise<{ readonly status: "accepted" | "conflict" }> {
    return this.client.request(
      `/internal/memory/proposal-sets/${encodeURIComponent(proposalSetId)}/approve`,
      VaultApproval,
      {
        init: {
          method: "POST",
          body: JSON.stringify({ reviewerId, acceptedAt }),
        },
        requestError: "vault request failed",
        invalidResponse: "vault returned an invalid approval result",
      },
    );
  }

  async recordTransition(transition: MemoryFunnelTransition): Promise<void> {
    await this.client.request(
      "/internal/memory/funnel-transitions",
      MemoryFunnelTransitionSchema,
      {
        init: { method: "POST", body: JSON.stringify(transition) },
        requestError: "vault funnel transition request failed",
        invalidResponse: "vault returned an invalid funnel transition",
      },
    );
  }
}

export interface CompilerWorkflowEnv {
  readonly MEMORY_VAULTS: DurableObjectNamespaceLike;
}

export class MemoryCompilerWorkflow extends WorkflowEntrypoint<
  CompilerWorkflowEnv,
  CompilerWorkflowInput
> {
  override run(
    event: WorkflowEvent<CompilerWorkflowInput>,
    step: WorkflowStep,
  ): Promise<CompilerWorkflowResult> {
    return runCompilerWorkflow(
      event.payload,
      new DurableObjectCompilerRepository(
        this.env.MEMORY_VAULTS,
        event.payload.organizationId,
      ),
      step as WorkflowStepLike,
    );
  }
}

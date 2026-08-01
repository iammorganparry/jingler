import {
  MemoryPage as MemoryPageSchema,
  buildIdentityIndex,
  canonicalJson,
  extractWikiLinks,
  lintMemory,
  normalizeMemoryIdentity,
  resolveWikiLink,
  stableContentHash,
  type MemoryPage
} from "@jingler/memory"
import { Schema } from "effect"
import type { DurableObjectNamespaceLike } from "../env.js"
import type { WorkflowEventLike, WorkflowStepLike } from "./compiler.js"
import { DurableObjectVaultClient } from "./vault-client.js"

export type ScheduledLintCode =
  | "orphaned-page"
  | "stale-dependency"
  | "duplicate-concept"
  | "uncited-claim"
  | "contradiction"
  | "broken-link"

export interface ScheduledLintFinding {
  readonly id: string
  readonly code: ScheduledLintCode
  readonly severity: "warning" | "error"
  readonly pageId: string
  readonly relatedPageId?: string
  readonly message: string
}

export interface ScheduledLintReport {
  readonly version: 1
  readonly workflowId: string
  readonly organizationId: string
  readonly asOf: string
  readonly scannedPages: number
  readonly findings: ReadonlyArray<ScheduledLintFinding>
  readonly counts: Readonly<Record<ScheduledLintCode, number>>
  readonly fingerprint: string
}

export interface LintAcceptedPage {
  readonly page: MemoryPage
  readonly acceptedAt: string
}

export interface ScheduledLintWorkflowInput {
  readonly workflowId: string
  readonly organizationId: string
  readonly asOf: string
}

export interface LintWorkflowRepository {
  listAcceptedPages(): Promise<ReadonlyArray<LintAcceptedPage>>
}

export class ScheduledLintWorkflowError extends Error {
  // biome-ignore lint/security/noSecrets: static Error class name, not a credential.
  override readonly name = "ScheduledLintWorkflowError"
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const conceptNames = (page: MemoryPage): ReadonlyArray<string> => {
  const values: Array<string> = []
  if (typeof page.metadata.concept === "string") values.push(page.metadata.concept)
  if (Array.isArray(page.metadata.concepts)) {
    for (const value of page.metadata.concepts) if (typeof value === "string") values.push(value)
  }
  return [...new Set(values.map(normalizeMemoryIdentity).filter((value) => value.length > 0))]
}

const finding = (
  code: ScheduledLintCode,
  pageId: string,
  message: string,
  relatedPageId?: string
): ScheduledLintFinding => ({
  id: `lint:${stableContentHash([code, pageId, relatedPageId ?? "", message].join("\u0000"))}`,
  code,
  severity: code === "uncited-claim" || code === "broken-link" ? "error" : "warning",
  pageId,
  ...(relatedPageId === undefined ? {} : { relatedPageId }),
  message
})

const metadataContradictions = (page: MemoryPage): ReadonlyArray<ScheduledLintFinding> => {
  const contradictions = page.metadata.contradictions
  if (!Array.isArray(contradictions)) return []
  return contradictions.flatMap((value) =>
    typeof value === "string"
      ? [finding("contradiction", page.id, `declared contradiction: ${value}`)]
      : []
  )
}

const contentLintFindings = (pages: ReadonlyArray<MemoryPage>): ReadonlyArray<ScheduledLintFinding> =>
  lintMemory(pages, { requireCitations: true }).issues.flatMap((issue) => {
    if (issue.pageId === undefined) return []
    if (issue.code === "uncited-claim") {
      return [finding("uncited-claim", issue.pageId, issue.message)]
    }
    return issue.code === "broken-reference"
      ? [finding("broken-link", issue.pageId, issue.message)]
      : []
  })

interface RelationshipAnalysis {
  readonly linkedPageIds: ReadonlyArray<string>
  readonly findings: ReadonlyArray<ScheduledLintFinding>
}

const relationshipAnalysisForPage = (
  page: MemoryPage,
  identities: ReadonlyMap<string, ReadonlyArray<MemoryPage>>,
  acceptedAt: ReadonlyMap<string, number>
): RelationshipAnalysis => {
  const wikiTargets = extractWikiLinks(page.body).flatMap((link) => {
    const target = resolveWikiLink(link.target, identities)
    return target === undefined ? [] : [target.id]
  })
  const findings: Array<ScheduledLintFinding> = []
  const dependencyTargets: Array<string> = []
  for (const relationship of page.relationships) {
    if (relationship.kind !== "dependency") continue
    const target = resolveWikiLink(relationship.target, identities)
    if (target === undefined) continue
    dependencyTargets.push(target.id)
    const dependentTime = acceptedAt.get(page.id)
    const dependencyTime = acceptedAt.get(target.id)
    if (
      dependentTime !== undefined &&
      dependencyTime !== undefined &&
      Number.isFinite(dependentTime) &&
      Number.isFinite(dependencyTime) &&
      dependencyTime > dependentTime
    ) {
      findings.push(
        finding(
          "stale-dependency",
          page.id,
          `dependency ${target.id} changed after this page was accepted`,
          target.id
        )
      )
    }
  }
  const targets = [...new Set([...wikiTargets, ...dependencyTargets])]
  return {
    linkedPageIds: targets.length === 0 ? [] : [page.id, ...targets],
    findings
  }
}

const duplicateConceptFindings = (
  pages: ReadonlyArray<MemoryPage>
): ReadonlyArray<ScheduledLintFinding> => {
  const pagesByConcept = new Map<string, Array<string>>()
  for (const page of pages) {
    for (const concept of conceptNames(page)) {
      const owners = pagesByConcept.get(concept) ?? []
      owners.push(page.id)
      pagesByConcept.set(concept, owners)
    }
  }
  return [...pagesByConcept].flatMap(([concept, owners]) => {
    if (owners.length < 2) return []
    const sortedOwners = [...owners].sort(compareText)
    return sortedOwners.map((pageId) =>
      finding(
        "duplicate-concept",
        pageId,
        `concept ${concept} is declared by ${sortedOwners.join(", ")}`
      )
    )
  })
}

const sortAndDedupeFindings = (
  findings: ReadonlyArray<ScheduledLintFinding>
): ReadonlyArray<ScheduledLintFinding> => {
  const unique = new Map(findings.map((item) => [item.id, item]))
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.pageId, right.pageId) ||
      compareText(left.code, right.code) ||
      compareText(left.id, right.id)
  )
}

export const buildScheduledLintReport = (
  workflowId: string,
  organizationId: string,
  accepted: ReadonlyArray<LintAcceptedPage>,
  asOf: string
): ScheduledLintReport => {
  const pages = accepted.map(({ page }) => page)
  const identities = buildIdentityIndex(pages)
  const acceptedAt = new Map(accepted.map((entry) => [entry.page.id, Date.parse(entry.acceptedAt)]))
  const relationships = pages.map((page) =>
    relationshipAnalysisForPage(page, identities, acceptedAt)
  )
  const linkedPages = new Set(relationships.flatMap((analysis) => analysis.linkedPageIds))
  const sorted = sortAndDedupeFindings([
    ...contentLintFindings(pages),
    ...relationships.flatMap((analysis) => analysis.findings),
    ...pages.flatMap(metadataContradictions),
    ...pages
      .filter((page) => !linkedPages.has(page.id))
      .map((page) => finding("orphaned-page", page.id, "page has no accepted wiki relationships")),
    ...duplicateConceptFindings(pages)
  ])
  const counts: Record<ScheduledLintCode, number> = {
    "orphaned-page": 0,
    "stale-dependency": 0,
    "duplicate-concept": 0,
    "uncited-claim": 0,
    contradiction: 0,
    "broken-link": 0
  }
  for (const item of sorted) counts[item.code] += 1
  const base: Omit<ScheduledLintReport, "fingerprint"> = {
    version: 1,
    workflowId,
    organizationId,
    asOf,
    scannedPages: pages.length,
    findings: sorted,
    counts
  }
  return { ...base, fingerprint: stableContentHash(canonicalJson(base)) }
}

export const runScheduledLintWorkflow = async (
  input: ScheduledLintWorkflowInput,
  repository: LintWorkflowRepository,
  step: WorkflowStepLike
): Promise<ScheduledLintReport> => {
  const accepted = await step.do("01-read-accepted-pages", () => repository.listAcceptedPages())
  return step.do("02-build-read-only-lint-report", () =>
    buildScheduledLintReport(
      input.workflowId,
      input.organizationId,
      accepted,
      input.asOf
    )
  )
}

const VaultLintPageHeads = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      pageId: Schema.String,
      acceptedAt: Schema.String
    })
  )
})
const VaultLintPage = Schema.Struct({ page: MemoryPageSchema })

export class DurableObjectLintRepository implements LintWorkflowRepository {
  private readonly client: DurableObjectVaultClient

  constructor(
    namespace: DurableObjectNamespaceLike,
    organizationId: string
  ) {
    this.client = new DurableObjectVaultClient(
      namespace,
      organizationId,
      () => new ScheduledLintWorkflowError("vault lint read failed")
    )
  }

  async listAcceptedPages(): Promise<ReadonlyArray<LintAcceptedPage>> {
    const { pages: heads } = await this.client.request(
      "/internal/memory/pages",
      VaultLintPageHeads,
      {
        requestError: "vault lint read failed",
        invalidResponse: "vault returned an invalid page list"
      }
    )
    return Promise.all(
      heads.map(async ({ pageId, acceptedAt }): Promise<LintAcceptedPage> => {
        const value = await this.client.request(
          `/internal/memory/pages/${encodeURIComponent(pageId)}`,
          VaultLintPage,
          {
            requestError: "vault lint read failed",
            invalidResponse: "vault returned an invalid accepted page"
          }
        )
        return {
          page: value.page,
          acceptedAt
        }
      })
    )
  }
}

export interface LintWorkflowEnv {
  readonly MEMORY_VAULTS: DurableObjectNamespaceLike
}

/** Read-only workflow: its durable output is a report and it never writes accepted content. */
export class MemoryLintWorkflow {
  constructor(readonly env: LintWorkflowEnv) {}

  run(
    event: WorkflowEventLike<ScheduledLintWorkflowInput>,
    step: WorkflowStepLike
  ): Promise<ScheduledLintReport> {
    return runScheduledLintWorkflow(
      event.payload,
      new DurableObjectLintRepository(this.env.MEMORY_VAULTS, event.payload.organizationId),
      step
    )
  }
}

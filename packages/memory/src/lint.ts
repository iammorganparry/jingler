import { Schema } from "effect"
import {
  buildIdentityIndex,
  canonicalJson,
  normalizeMemoryIdentity,
  stableContentHash
} from "./graph.js"
import {
  extractCitationDefinitions,
  extractCitationReferences,
  extractMarkdownClaims,
  extractMarkdownHeadings,
  extractWikiLinks,
  serializeMemoryMarkdown,
  slugifyMarkdownHeading
} from "./markdown.js"
import type {
  MemoryAuditEvent,
  MemoryPage,
  MemoryProposal,
  MemoryRevision,
  MemoryRole,
  MemorySource
} from "./model.js"

export const DEFAULT_MAX_PAGE_BYTES = 64 * 1024

export const MemoryLintCode = Schema.Literal(
  "unsafe-path",
  "duplicate-identity",
  "broken-reference",
  "ambiguous-reference",
  "broken-citation",
  "uncited-claim",
  "oversized-page",
  "credential",
  "stale-base",
  "unknown-page",
  "invalid-revision",
  "invalid-proposal",
  "invalid-audit-event"
)
export type MemoryLintCode = Schema.Schema.Type<typeof MemoryLintCode>

export const MemoryLintIssue = Schema.Struct({
  code: MemoryLintCode,
  severity: Schema.Literal("error", "warning"),
  message: Schema.String,
  path: Schema.optional(Schema.String),
  pageId: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number)
})
export type MemoryLintIssue = Schema.Schema.Type<typeof MemoryLintIssue>

export interface MemoryLintInput {
  readonly pages: ReadonlyArray<MemoryPage>
  readonly sources?: ReadonlyArray<MemorySource>
  readonly revisions?: ReadonlyArray<MemoryRevision>
  readonly proposals?: ReadonlyArray<MemoryProposal>
  readonly roles?: ReadonlyArray<MemoryRole>
  readonly auditEvents?: ReadonlyArray<MemoryAuditEvent>
}

export interface MemoryLintOptions {
  readonly maxPageBytes?: number
  /** Default true. Pages may individually opt out with `citationPolicy: none`. */
  readonly requireCitations?: boolean
  /** Explicit page heads take precedence over heads derived from revisions. */
  readonly headRevisionIds?: Readonly<Record<string, string>>
}

export interface MemoryLintResult {
  readonly ok: boolean
  readonly issues: ReadonlyArray<MemoryLintIssue>
  readonly errors: ReadonlyArray<MemoryLintIssue>
  readonly warnings: ReadonlyArray<MemoryLintIssue>
}

export class MemoryLintError extends Error {
  override readonly name = "MemoryLintError"

  constructor(readonly issues: ReadonlyArray<MemoryLintIssue>) {
    super(
      `memory validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues
        .map((issue) => issue.code)
        .join(", ")}`
    )
  }
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

const decodedPath = (path: string): string => {
  let decoded = path
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

export const unsafeMemoryPathReason = (path: string): string | undefined => {
  const decoded = decodedPath(path)
  if (path === "" || path.trim() !== path) return "path must be non-empty and have no outer whitespace"
  if (decoded.includes("\0")) return "path contains a NUL byte"
  if (decoded.includes("\\")) return "path must use forward slashes"
  if (decoded.startsWith("/") || decoded.startsWith("//")) return "absolute paths are not allowed"
  if (/^[A-Za-z]:/.test(decoded)) return "drive-qualified paths are not allowed"
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) return "URL-like paths are not allowed"
  const segments = decoded.split("/")
  if (segments.some((segment) => segment === "..")) return "path traversal is not allowed"
  if (segments.some((segment) => segment === "." || segment === "")) {
    return "path must be in canonical relative form"
  }
  return undefined
}

export const isSafeMemoryPath = (path: string): boolean => unsafeMemoryPathReason(path) === undefined

interface CredentialPattern {
  readonly label: string
  readonly pattern: RegExp
}

const CREDENTIAL_PATTERNS: ReadonlyArray<CredentialPattern> = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    label: "provider token",
    pattern:
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/
  },
  {
    label: "assigned credential",
    pattern:
      /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/_.-]{16,}/i
  }
]

export interface CredentialFinding {
  readonly kind: string
  readonly line: number
}

/** Returns positions only; secret values never enter lint messages. */
export const findCredentialShapedContent = (value: string): Array<CredentialFinding> => {
  const findings: Array<CredentialFinding> = []
  const lines = value.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    for (const credential of CREDENTIAL_PATTERNS) {
      if (credential.pattern.test(lines[index]!)) {
        findings.push({ kind: credential.label, line: index + 1 })
      }
    }
  }
  return findings
}

const issueForPage = (
  page: MemoryPage,
  code: MemoryLintCode,
  message: string,
  line?: number
): MemoryLintIssue => ({
  code,
  severity: "error",
  message,
  path: page.path,
  pageId: page.id,
  ...(line === undefined ? {} : { line })
})

const lintPageContent = (
  page: MemoryPage,
  identities: ReadonlyMap<string, ReadonlyArray<MemoryPage>>,
  headingsByPage: Map<string, ReadonlySet<string>>,
  sources: ReadonlyMap<string, MemorySource>,
  options: Required<Pick<MemoryLintOptions, "maxPageBytes" | "requireCitations">>
): Array<MemoryLintIssue> => {
  const issues: Array<MemoryLintIssue> = []
  const unsafeReason = unsafeMemoryPathReason(page.path)
  if (unsafeReason !== undefined) issues.push(issueForPage(page, "unsafe-path", unsafeReason))

  const serialized = serializeMemoryMarkdown(page)
  const size = utf8ByteLength(serialized)
  if (size > options.maxPageBytes) {
    issues.push(
      issueForPage(
        page,
        "oversized-page",
        `page is ${size} bytes; maximum is ${options.maxPageBytes} bytes`
      )
    )
  }
  for (const finding of findCredentialShapedContent(serialized)) {
    issues.push(
      issueForPage(
        page,
        "credential",
        `${finding.kind}-shaped content is not allowed`,
        finding.line
      )
    )
  }

  for (const link of extractWikiLinks(page.body)) {
    const unsafeTargetReason = unsafeMemoryPathReason(link.target)
    if (link.target !== "" && unsafeTargetReason !== undefined) {
      issues.push(
        issueForPage(page, "unsafe-path", `wikilink target is unsafe: ${unsafeTargetReason}`, link.line)
      )
      continue
    }
    const matches =
      link.target === "" ? [page] : (identities.get(normalizeMemoryIdentity(link.target)) ?? [])
    if (matches.length === 0) {
      issues.push(
        issueForPage(page, "broken-reference", `wikilink target "${link.target}" does not exist`, link.line)
      )
      continue
    }
    if (matches.length > 1) {
      issues.push(
        issueForPage(
          page,
          "ambiguous-reference",
          `wikilink target "${link.target}" matches ${matches.length} pages`,
          link.line
        )
      )
      continue
    }
    if (link.anchor !== undefined) {
      const target = matches[0]!
      let headings = headingsByPage.get(target.id)
      if (headings === undefined) {
        headings = extractMarkdownHeadings(target.body)
        headingsByPage.set(target.id, headings)
      }
      if (!headings.has(slugifyMarkdownHeading(link.anchor))) {
        issues.push(
          issueForPage(
            page,
            "broken-reference",
            `wikilink anchor "${link.anchor}" does not exist on "${link.target}"`,
            link.line
          )
        )
      }
    }
  }

  for (const relationship of page.relationships) {
    if (relationship.kind !== "dependency") continue
    const unsafeTargetReason = unsafeMemoryPathReason(relationship.target)
    if (unsafeTargetReason !== undefined) {
      issues.push(
        issueForPage(
          page,
          "unsafe-path",
          `dependency target is unsafe: ${unsafeTargetReason}`
        )
      )
      continue
    }
    const matches = identities.get(normalizeMemoryIdentity(relationship.target)) ?? []
    if (matches.length === 0) {
      issues.push(
        issueForPage(
          page,
          "broken-reference",
          `dependency target "${relationship.target}" does not exist`
        )
      )
    } else if (matches.length > 1) {
      issues.push(
        issueForPage(
          page,
          "ambiguous-reference",
          `dependency target "${relationship.target}" matches ${matches.length} pages`
        )
      )
    }
  }

  const pageSources = new Map(sources)
  for (const source of page.sources) pageSources.set(source.id, source)
  const knownCitations = new Set<string>(extractCitationDefinitions(page.body))
  for (const source of pageSources.values()) knownCitations.add(source.id)
  const citationIds = new Set<string>()
  for (const citation of page.citations) {
    if (citationIds.has(citation.id)) {
      issues.push(
        issueForPage(page, "duplicate-identity", `citation id "${citation.id}" is declared more than once`)
      )
    }
    citationIds.add(citation.id)
    knownCitations.add(citation.id)
    if (!pageSources.has(citation.sourceId)) {
      issues.push(
        issueForPage(
          page,
          "broken-citation",
          `citation "${citation.id}" refers to missing source "${citation.sourceId}"`
        )
      )
    }
  }
  for (const reference of extractCitationReferences(page.body)) {
    if (!knownCitations.has(reference.id)) {
      issues.push(
        issueForPage(
          page,
          "broken-citation",
          `citation reference "${reference.id}" is not declared`,
          reference.line
        )
      )
    }
  }

  const citationPolicy = page.metadata.citationPolicy
  if (options.requireCitations && citationPolicy !== "none") {
    for (const claim of extractMarkdownClaims(page.body)) {
      if (claim.citationIds.length === 0) {
        issues.push(
          issueForPage(page, "uncited-claim", "prose claim must include a citation", claim.line)
        )
      }
    }
  }
  return issues
}

const addDuplicateIssues = (
  pages: ReadonlyArray<MemoryPage>,
  issues: Array<MemoryLintIssue>
): void => {
  const identities = buildIdentityIndex(pages)
  for (const [identity, matches] of identities) {
    if (matches.length < 2) continue
    for (const page of matches) {
      issues.push(
        issueForPage(
          page,
          "duplicate-identity",
          `identity "${identity}" is shared by ${matches.map((match) => match.path).join(", ")}`
        )
      )
    }
  }

}

const lintUniqueRecordIds = (
  values: ReadonlyArray<{ readonly id: string }>,
  label: string,
  issues: Array<MemoryLintIssue>
): void => {
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.id.toLocaleLowerCase("en-US")
    if (seen.has(key)) {
      issues.push({
        code: "duplicate-identity",
        severity: "error",
        message: `${label} id "${value.id}" is declared more than once`
      })
    }
    seen.add(key)
  }
}

const lintPageSources = (
  pages: ReadonlyArray<MemoryPage>,
  repositorySources: ReadonlyArray<MemorySource>,
  issues: Array<MemoryLintIssue>
): void => {
  const definitions = new Map<string, { readonly hash: string; readonly owner: string }>()
  for (const page of pages) {
    lintUniqueRecordIds(page.sources, `source on page "${page.id}"`, issues)
  }
  const ownedSources: Array<{ readonly owner: string; readonly source: MemorySource }> = [
    ...repositorySources.map((source) => ({ owner: "repository", source })),
    ...pages.flatMap((page) => page.sources.map((source) => ({ owner: page.path, source })))
  ]
  for (const { owner, source } of ownedSources) {
    const key = source.id.toLocaleLowerCase("en-US")
    const hash = stableContentHash(canonicalJson(source))
    const existing = definitions.get(key)
    if (existing !== undefined && existing.hash !== hash) {
      issues.push({
        code: "duplicate-identity",
        severity: "error",
        message: `source id "${source.id}" has conflicting definitions in ${existing.owner} and ${owner}`
      })
    } else if (existing === undefined) {
      definitions.set(key, { hash, owner })
    }
  }
}

const revisionHeads = (
  revisions: ReadonlyArray<MemoryRevision>,
  explicit: Readonly<Record<string, string>>
): ReadonlyMap<string, string> => {
  const latest = new Map<string, MemoryRevision>()
  for (const revision of revisions) {
    const current = latest.get(revision.pageId)
    if (current === undefined || revision.revision > current.revision) latest.set(revision.pageId, revision)
  }
  const heads = new Map<string, string>(
    [...latest.entries()].map(([pageId, revision]) => [pageId, revision.id])
  )
  for (const [pageId, revisionId] of Object.entries(explicit)) heads.set(pageId, revisionId)
  return heads
}

const lintRevisionsAndProposals = (
  pages: ReadonlyArray<MemoryPage>,
  revisions: ReadonlyArray<MemoryRevision>,
  proposals: ReadonlyArray<MemoryProposal>,
  options: MemoryLintOptions,
  issues: Array<MemoryLintIssue>
): void => {
  const pageIds = new Set(pages.map((page) => page.id))
  const revisionIds = new Set(revisions.map((revision) => revision.id))
  const heads = revisionHeads(revisions, options.headRevisionIds ?? {})
  lintUniqueRecordIds(revisions, "revision", issues)
  lintUniqueRecordIds(proposals, "proposal", issues)

  for (const revision of revisions) {
    if (!pageIds.has(revision.pageId)) {
      issues.push({
        code: "unknown-page",
        severity: "error",
        message: `revision "${revision.id}" refers to missing page "${revision.pageId}"`,
        pageId: revision.pageId
      })
    }
    if (revision.parentRevisionId !== undefined && !revisionIds.has(revision.parentRevisionId)) {
      issues.push({
        code: "invalid-revision",
        severity: "error",
        message: `revision "${revision.id}" has missing parent "${revision.parentRevisionId}"`,
        pageId: revision.pageId
      })
    }
  }

  for (const proposal of proposals) {
    if (!pageIds.has(proposal.pageId)) {
      issues.push({
        code: "unknown-page",
        severity: "error",
        message: `proposal "${proposal.id}" refers to missing page "${proposal.pageId}"`,
        pageId: proposal.pageId
      })
      continue
    }
    const head = heads.get(proposal.pageId)
    if (head !== undefined && proposal.baseRevisionId !== head) {
      issues.push({
        code: "stale-base",
        severity: "error",
        message: `proposal "${proposal.id}" is based on "${proposal.baseRevisionId}", not head "${head}"`,
        pageId: proposal.pageId
      })
    } else if (revisions.length > 0 && !revisionIds.has(proposal.baseRevisionId)) {
      issues.push({
        code: "stale-base",
        severity: "error",
        message: `proposal "${proposal.id}" has unknown base revision "${proposal.baseRevisionId}"`,
        pageId: proposal.pageId
      })
    }
    for (const finding of findCredentialShapedContent(proposal.markdown)) {
      issues.push({
        code: "credential",
        severity: "error",
        message: `proposal "${proposal.id}" contains ${finding.kind}-shaped content`,
        pageId: proposal.pageId,
        line: finding.line
      })
    }
  }
}

const lintRolesAndAuditEvents = (
  repository: MemoryLintInput,
  issues: Array<MemoryLintIssue>
): void => {
  const pages = new Set(repository.pages.map((page) => page.id))
  const revisions = new Set((repository.revisions ?? []).map((revision) => revision.id))
  const proposals = new Set((repository.proposals ?? []).map((proposal) => proposal.id))
  const auditEvents = repository.auditEvents ?? []
  lintUniqueRecordIds(auditEvents, "audit event", issues)
  for (const role of repository.roles ?? []) {
    if (role.pageId !== undefined && !pages.has(role.pageId)) {
      issues.push({
        code: "unknown-page",
        severity: "error",
        message: `role for "${role.principalId}" refers to missing page "${role.pageId}"`,
        pageId: role.pageId
      })
    }
  }
  for (const event of auditEvents) {
    if (event.pageId !== undefined && !pages.has(event.pageId)) {
      issues.push({
        code: "unknown-page",
        severity: "error",
        message: `audit event "${event.id}" refers to missing page "${event.pageId}"`,
        pageId: event.pageId
      })
    }
    if (event.revisionId !== undefined && !revisions.has(event.revisionId)) {
      issues.push({
        code: "invalid-audit-event",
        severity: "error",
        message: `audit event "${event.id}" refers to missing revision "${event.revisionId}"`,
        ...(event.pageId === undefined ? {} : { pageId: event.pageId })
      })
    }
    if (event.proposalId !== undefined && !proposals.has(event.proposalId)) {
      issues.push({
        code: "invalid-audit-event",
        severity: "error",
        message: `audit event "${event.id}" refers to missing proposal "${event.proposalId}"`,
        ...(event.pageId === undefined ? {} : { pageId: event.pageId })
      })
    }
  }
}

const isPageArray = (
  input: ReadonlyArray<MemoryPage> | MemoryLintInput
): input is ReadonlyArray<MemoryPage> => Array.isArray(input)

const normalizeInput = (input: ReadonlyArray<MemoryPage> | MemoryLintInput): MemoryLintInput =>
  isPageArray(input) ? { pages: input } : input

export const lintMemory = (
  input: ReadonlyArray<MemoryPage> | MemoryLintInput,
  options: MemoryLintOptions = {}
): MemoryLintResult => {
  const repository = normalizeInput(input)
  const pages = repository.pages
  const sources = repository.sources ?? []
  const issues: Array<MemoryLintIssue> = []
  lintUniqueRecordIds(pages, "page", issues)
  lintUniqueRecordIds(sources, "source", issues)
  lintPageSources(pages, sources, issues)
  addDuplicateIssues(pages, issues)
  const sourcesById = new Map(sources.map((source) => [source.id, source]))
  const identities = buildIdentityIndex(pages)
  const headingsByPage = new Map<string, ReadonlySet<string>>()
  const pageOptions = {
    maxPageBytes: options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES,
    requireCitations: options.requireCitations ?? true
  }
  for (const page of pages) {
    issues.push(...lintPageContent(page, identities, headingsByPage, sourcesById, pageOptions))
  }
  lintRevisionsAndProposals(
    pages,
    repository.revisions ?? [],
    repository.proposals ?? [],
    options,
    issues
  )
  lintRolesAndAuditEvents(repository, issues)

  const unique = new Map<string, MemoryLintIssue>()
  for (const issue of issues) {
    const key = stableContentHash(
      [issue.code, issue.path ?? "", issue.pageId ?? "", String(issue.line ?? ""), issue.message].join(
        "\u0000"
      )
    )
    unique.set(key, issue)
  }
  const sorted = [...unique.values()].sort(
    (left, right) =>
      compareText(left.path ?? "", right.path ?? "") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message)
  )
  const errors = sorted.filter((issue) => issue.severity === "error")
  const warnings = sorted.filter((issue) => issue.severity === "warning")
  return { ok: errors.length === 0, issues: sorted, errors, warnings }
}

export const assertMemoryValid = (
  input: ReadonlyArray<MemoryPage> | MemoryLintInput,
  options: MemoryLintOptions = {}
): void => {
  const result = lintMemory(input, options)
  if (!result.ok) throw new MemoryLintError(result.errors)
}

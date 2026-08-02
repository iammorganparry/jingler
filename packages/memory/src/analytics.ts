import { Schema } from "effect"
import { extractCitationReferences, extractWikiLinks } from "./markdown.js"
import {
  MemoryAuditEventType,
  type MemoryAuditEvent,
  type MemoryPage
} from "./model.js"
import { compareText } from "./text.js"

export const MemoryAnalyticsEventCount = Schema.Struct({
  type: MemoryAuditEventType,
  count: Schema.Int.pipe(Schema.nonNegative())
})
export type MemoryAnalyticsEventCount = Schema.Schema.Type<typeof MemoryAnalyticsEventCount>

export const MemoryPageAnalytics = Schema.Struct({
  pageId: Schema.String,
  revision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  citations: Schema.Int.pipe(Schema.nonNegative()),
  wikilinks: Schema.Int.pipe(Schema.nonNegative()),
  relationships: Schema.Int.pipe(Schema.nonNegative()),
  events: Schema.Int.pipe(Schema.nonNegative()),
  lastActivityAt: Schema.NullOr(Schema.String)
})
export type MemoryPageAnalytics = Schema.Schema.Type<typeof MemoryPageAnalytics>

/** A reproducible projection of accepted pages and their accepted audit log. */
export const MemoryAnalyticsSummary = Schema.Struct({
  version: Schema.Literal(1),
  pageCount: Schema.Int.pipe(Schema.nonNegative()),
  sourceCount: Schema.Int.pipe(Schema.nonNegative()),
  citationCount: Schema.Int.pipe(Schema.nonNegative()),
  wikilinkCount: Schema.Int.pipe(Schema.nonNegative()),
  relationshipCount: Schema.Int.pipe(Schema.nonNegative()),
  eventCount: Schema.Int.pipe(Schema.nonNegative()),
  actorCount: Schema.Int.pipe(Schema.nonNegative()),
  eventTypes: Schema.Array(MemoryAnalyticsEventCount),
  pages: Schema.Array(MemoryPageAnalytics)
})
export type MemoryAnalyticsSummary = Schema.Schema.Type<typeof MemoryAnalyticsSummary>

export class MemoryAnalyticsError extends Error {
  override readonly name = "MemoryAnalyticsError"
}

const lastActivityFor = (
  pageId: string,
  events: ReadonlyArray<MemoryAuditEvent>
): string | null => {
  const timestamps = events
    .filter((event) => event.pageId === pageId)
    .map((event) => event.occurredAt)
    .sort(compareText)
  return timestamps.at(-1) ?? null
}

export const buildMemoryAnalytics = (
  pages: ReadonlyArray<MemoryPage>,
  events: ReadonlyArray<MemoryAuditEvent> = []
): MemoryAnalyticsSummary => {
  const sourceIds = new Set<string>()
  for (const page of pages) {
    for (const source of page.sources) sourceIds.add(source.id)
  }
  const eventCounts = new Map<MemoryAuditEvent["type"], number>()
  for (const event of events) eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1)

  const pageSummaries = [...pages]
    .sort((left, right) => compareText(left.id, right.id))
    .map((page) => ({
      pageId: page.id,
      revision: page.revision,
      citations: extractCitationReferences(page.body).length,
      wikilinks: extractWikiLinks(page.body).length,
      relationships: page.relationships.length,
      events: events.filter((event) => event.pageId === page.id).length,
      lastActivityAt: lastActivityFor(page.id, events)
    }))

  return {
    version: 1,
    pageCount: pages.length,
    sourceCount: sourceIds.size,
    citationCount: pageSummaries.reduce((total, page) => total + page.citations, 0),
    wikilinkCount: pageSummaries.reduce((total, page) => total + page.wikilinks, 0),
    relationshipCount: pageSummaries.reduce((total, page) => total + page.relationships, 0),
    eventCount: events.length,
    actorCount: new Set(events.map((event) => event.actorId)).size,
    eventTypes: [...eventCounts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([type, count]) => ({ type, count })),
    pages: pageSummaries
  }
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalValue(child)])
    )
  }
  return value
}

export const serializeMemoryAnalytics = (summary: MemoryAnalyticsSummary): string =>
  `${JSON.stringify(canonicalValue(summary), null, 2)}\n`

export const parseMemoryAnalytics = (value: string): MemoryAnalyticsSummary => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new MemoryAnalyticsError(`invalid memory analytics JSON: ${String(error)}`)
  }
  return Schema.decodeUnknownSync(MemoryAnalyticsSummary)(parsed)
}

export const createMemoryAnalytics = buildMemoryAnalytics

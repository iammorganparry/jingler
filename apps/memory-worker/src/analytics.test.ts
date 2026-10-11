import type {
  MemoryAuditEvent,
  MemoryPage,
  MemoryRelationshipEvidence,
} from "@jingler/memory";
import { describe, expect, it } from "vitest";
import {
  buildVaultDashboardSummary,
  buildWeeklyQualityReport,
  evaluateMemoryRolloutHealth,
  type VaultAnalyticsInput,
} from "./analytics.js";

const pages: ReadonlyArray<MemoryPage> = [
  {
    id: "alpha",
    path: "alpha.md",
    title: "Alpha",
    revision: 2,
    aliases: [],
    tags: ["topic"],
    sources: [],
    citations: [{ id: "citation-1", sourceId: "source-1" }],
    relationships: [],
    body: "# Alpha\n\nA supported fact links to [[Beta]]. [@citation-1]\n",
    metadata: { contradictions: ["claim-a", "claim-b"] },
  },
  {
    id: "beta",
    path: "beta.md",
    title: "Beta",
    revision: 1,
    aliases: [],
    tags: [],
    sources: [],
    citations: [],
    relationships: [],
    body: "# Beta\n",
    metadata: { citationPolicy: "none" },
  },
  {
    id: "gamma",
    path: "gamma.md",
    title: "Gamma",
    revision: 1,
    aliases: [],
    tags: [],
    sources: [],
    citations: [],
    relationships: [],
    body: "# Gamma\n\nA stale reference points to [[Missing]].\n",
    metadata: { citationPolicy: "none" },
  },
];

const events: ReadonlyArray<MemoryAuditEvent> = [
  {
    id: "accepted",
    type: "proposal.accepted",
    actorId: "reviewer",
    occurredAt: "2026-07-02T00:00:00.000Z",
    proposalId: "accepted-proposal",
    details: {},
  },
  {
    id: "rejected",
    type: "proposal.rejected",
    actorId: "reviewer",
    occurredAt: "2026-07-04T00:00:00.000Z",
    proposalId: "rejected-proposal",
    details: {},
  },
];

const acceptedRelationship = (
  source: MemoryPage,
  target: MemoryPage,
  kind: MemoryRelationshipEvidence["kind"],
  quote: string,
): MemoryRelationshipEvidence => {
  const start = source.body.indexOf(quote);
  if (start < 0) throw new Error("fixture quote is missing");
  return {
    id: `evidence:${source.id}:${target.id}:${kind}`,
    relationshipId: `relationship:${source.id}:${target.id}:${kind}`,
    kind,
    sourcePageId: source.id,
    targetPageId: target.id,
    sourceRevisionId: `revision:${source.id}`,
    start,
    end: start + quote.length,
    quote,
    compilerEvidence: {
      sourceId: "source-1",
      start: 0,
      end: quote.length,
      quote,
    },
    acceptedBy: "reviewer",
    acceptedAt: "2026-08-01T00:00:00.000Z",
  };
};

describe("vault dashboard analytics", () => {
  it("exactly aggregates growth, coverage, freshness, health, review, connectivity, and retrieval", () => {
    const input: VaultAnalyticsInput = {
      pages,
      sourceCount: 1,
      revisions: [
        {
          id: "r1",
          pageId: "alpha",
          createdAt: "2026-01-01T00:00:00.000Z",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          pageId: "alpha",
          createdAt: "2026-07-01T00:00:00.000Z",
          acceptedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "r3",
          pageId: "beta",
          createdAt: "2026-07-20T00:00:00.000Z",
          acceptedAt: "2026-07-20T00:00:00.000Z",
        },
        {
          id: "r4",
          pageId: "gamma",
          createdAt: "2026-06-01T00:00:00.000Z",
          acceptedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      proposals: [
        {
          id: "accepted-proposal",
          createdAt: "2026-07-01T00:00:00.000Z",
          status: "accepted",
        },
        {
          id: "rejected-proposal",
          createdAt: "2026-07-02T00:00:00.000Z",
          status: "rejected",
        },
        {
          id: "conflict",
          createdAt: "2026-07-03T00:00:00.000Z",
          status: "superseded",
        },
        { id: "open", createdAt: "2026-07-04T00:00:00.000Z", status: "open" },
      ],
      events,
      heads: [
        { pageId: "alpha", acceptedAt: "2026-07-20T00:00:00.000Z" },
        { pageId: "beta", acceptedAt: "2026-01-01T00:00:00.000Z" },
        { pageId: "gamma", acceptedAt: "2026-06-01T00:00:00.000Z" },
      ],
      retrievals: [
        {
          id: "q1",
          occurredAt: "2026-07-01",
          queryHash: "hash-a",
          resultCount: 2,
          durationMs: 10,
        },
        {
          id: "q2",
          occurredAt: "2026-07-02",
          queryHash: "hash-b",
          resultCount: 0,
          durationMs: 30,
        },
        {
          id: "q3",
          occurredAt: "2026-07-03",
          queryHash: "hash-a",
          resultCount: 4,
          durationMs: 20,
        },
      ],
      sessionRetrievals: [
        {
          id: "session-retrieval:source-1",
          occurredAt: "2026-07-04",
          searches: 2,
          reads: 3,
          navigation: 1,
          graphReads: 4,
          proposals: 1,
        },
      ],
      relationshipEvidence: [
        acceptedRelationship(
          pages[0]!,
          pages[1]!,
          "wikilink",
          "A supported fact links to [[Beta]].",
        ),
      ],
      funnelTransitions: [
        {
          id: "funnel-source-1-captured",
          occurredAt: "2026-07-01T00:00:00.000Z",
          stage: "capture",
          outcome: "captured",
          sourceId: "source-1",
          sourceKind: "conversation",
        },
        {
          id: "funnel-source-1-delivered",
          occurredAt: "2026-07-01T00:00:01.000Z",
          stage: "delivery",
          outcome: "delivered",
          sourceId: "source-1",
          sourceKind: "conversation",
          workflowId: "compiler-source-1",
        },
        {
          id: "funnel-source-1-published",
          occurredAt: "2026-07-02T00:00:00.000Z",
          stage: "publication",
          outcome: "published",
          sourceId: "source-1",
          sourceKind: "conversation",
          workflowId: "compiler-source-1",
          proposalSetId: "proposal:compiler-source-1",
          publicationIds: ["revision:one"],
        },
      ],
    };
    expect(
      buildVaultDashboardSummary(input, "2026-08-01T00:00:00.000Z"),
    ).toMatchObject({
      version: 1,
      asOf: "2026-08-01T00:00:00.000Z",
      growth: {
        acceptedPages: 3,
        revisions: 4,
        sources: 1,
        daily: [
          { day: "2026-01-01", pages: 1, revisions: 1 },
          { day: "2026-06-01", pages: 1, revisions: 1 },
          { day: "2026-07-01", pages: 0, revisions: 1 },
          { day: "2026-07-20", pages: 1, revisions: 1 },
        ],
      },
      citationCoverage: {
        citations: 1,
        citedPages: 1,
        totalPages: 3,
        ratio: 0.3333,
      },
      freshness: { fresh: 1, aging: 1, stale: 1, unknown: 0 },
      health: { orphanPages: 1, brokenLinks: 1, contradictions: 2 },
      reviewThroughput: {
        proposed: 4,
        accepted: 1,
        rejected: 1,
        conflicted: 1,
        open: 1,
        acceptanceRatio: 0.3333,
        medianReviewHours: 36,
      },
      connectivity: {
        pages: 3,
        directedLinks: 1,
        citationEdges: 1,
        durablePageEdges: 1,
        connectedPages: 2,
        averageDegree: 0.6667,
      },
      retrieval: {
        searches: 5,
        reads: 3,
        navigation: 1,
        graphReads: 4,
        proposals: 1,
        zeroResultSearches: 1,
        zeroResultRatio: 0.3333,
        resultsReturned: 6,
        uniqueQueryHashes: 2,
        medianDurationMs: 20,
        p95DurationMs: 30,
      },
      funnel: {
        transitions: 3,
        outcomes: [
          { outcome: "captured", count: 1 },
          { outcome: "delivered", count: 1 },
          { outcome: "published", count: 1 },
        ],
        bySourceKind: [
          {
            sourceKind: "conversation",
            sources: 1,
            captured: 1,
            delivered: 1,
            proposals: 0,
            pendingReview: 0,
            published: 1,
            noDurableLearning: 0,
            conflicted: 0,
            rejected: 0,
            permanentFailures: 0,
            deliveryFailures: 0,
          },
        ],
      },
    });
  });

  it("builds content-free weekly quality segments by harness, source kind, arm, and length", () => {
    const rollout = {
      version: 1 as const,
      policyRevision: "r1",
      allocationId: "allocation-one",
      harness: "claude" as const,
      sessionLengthCohort: "long" as const,
      arms: ["reflection" as const],
    };
    const transitions = [
      {
        id: "captured",
        occurredAt: "2026-08-05T00:00:00.000Z",
        stage: "capture" as const,
        outcome: "captured" as const,
        sourceId: "source-one",
        sourceKind: "conversation" as const,
        rollout,
      },
      {
        id: "delivered",
        occurredAt: "2026-08-05T00:00:01.000Z",
        stage: "delivery" as const,
        outcome: "delivered" as const,
        sourceId: "source-one",
        sourceKind: "conversation" as const,
        rollout,
      },
      {
        id: "published",
        occurredAt: "2026-08-05T00:00:02.000Z",
        stage: "publication" as const,
        outcome: "published" as const,
        sourceId: "source-one",
        sourceKind: "conversation" as const,
        rollout,
      },
      {
        id: "quality",
        occurredAt: "2026-08-05T00:00:03.000Z",
        stage: "review" as const,
        outcome: "quality_sampled" as const,
        sourceId: "source-one",
        sourceKind: "conversation" as const,
        rollout,
        quality: {
          reviewedCandidates: 1,
          durablePositiveCandidates: 1,
          submittedCandidates: 1,
          returnedHandles: 1,
          terminalPolls: 1,
          acceptedAsIs: 1,
          rejected: 0,
          nearDuplicates: 0,
          exactDuplicates: 0,
          sensitiveEscapes: 0,
          brokenEvidence: 0,
        },
      },
    ];

    const report = buildWeeklyQualityReport(
      transitions,
      "2026-08-06T00:00:00.000Z",
    );

    expect(report.totals).toMatchObject({
      sources: 1,
      deliveredSources: 1,
      terminalSources: 1,
      proposalRecall: 1,
      pollingCompleteness: 1,
      acceptAsIsRatio: 1,
      terminalSettlementRatio: 1,
    });
    expect(report.segments).toEqual([
      expect.objectContaining({
        harness: "claude",
        sourceKind: "conversation",
        experimentArm: "reflection",
        sessionLengthCohort: "long",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("content");
    expect(JSON.stringify(report)).not.toContain("transcript");
  });

  it("automatically stops unsafe arms for every audited guardrail", () => {
    const delivered = Array.from({ length: 20 }, (_, index) => ({
      id: `delivered-${index}`,
      occurredAt: "2026-08-05T00:00:00.000Z",
      stage: "delivery" as const,
      outcome: "delivered" as const,
      sourceId: `source-${index}`,
      sourceKind: "conversation" as const,
    }));
    const terminal = Array.from({ length: 18 }, (_, index) => ({
      id: `published-${index}`,
      occurredAt: "2026-08-05T00:01:00.000Z",
      stage: "publication" as const,
      outcome: "published" as const,
      sourceId: `source-${index}`,
      sourceKind: "conversation" as const,
    }));
    const report = buildWeeklyQualityReport(
      [
        ...delivered,
        ...terminal,
        {
          id: "workflow-error",
          occurredAt: "2026-08-05T00:02:00.000Z",
          stage: "compilation" as const,
          outcome: "infrastructure_failure" as const,
          sourceId: "source-18",
          sourceKind: "conversation" as const,
        },
        {
          id: "unsafe-quality",
          occurredAt: "2026-08-05T00:03:00.000Z",
          stage: "review" as const,
          outcome: "quality_sampled" as const,
          sourceId: "source-0",
          sourceKind: "conversation" as const,
          quality: {
            reviewedCandidates: 20,
            durablePositiveCandidates: 20,
            submittedCandidates: 10,
            returnedHandles: 10,
            terminalPolls: 9,
            acceptedAsIs: 15,
            rejected: 4,
            nearDuplicates: 1,
            exactDuplicates: 1,
            sensitiveEscapes: 1,
            brokenEvidence: 1,
          },
        },
      ],
      "2026-08-06T00:00:00.000Z",
    );

    const health = evaluateMemoryRolloutHealth(report);

    expect(health.safeToExpand).toBe(false);
    expect(health.stops.map(({ reason }) => reason)).toEqual([
      "sensitive_escape",
      "workflow_errors",
      "rejection",
      "duplication",
      "broken_evidence",
      "unexplained_funnel_delta",
    ]);
    expect(health.stoppedArms).toContain("auto_publication");
    expect(health.stoppedArms).toContain("relationship_review");
  });

  it("windows time-scoped series by the selected range relative to asOf", () => {
    const asOf = "2026-08-01T00:00:00.000Z";
    const input: VaultAnalyticsInput = {
      pages,
      sourceCount: 2,
      revisions: [
        {
          id: "r-old",
          pageId: "alpha",
          createdAt: "2026-01-01T00:00:00.000Z",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r-90",
          pageId: "alpha",
          createdAt: "2026-05-20T00:00:00.000Z",
          acceptedAt: "2026-05-20T00:00:00.000Z",
        },
        {
          id: "r-30",
          pageId: "beta",
          createdAt: "2026-07-10T00:00:00.000Z",
          acceptedAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "r-7",
          pageId: "gamma",
          createdAt: "2026-07-28T00:00:00.000Z",
          acceptedAt: "2026-07-28T00:00:00.000Z",
        },
      ],
      proposals: [
        {
          id: "p-old",
          createdAt: "2026-01-15T00:00:00.000Z",
          status: "accepted",
        },
        { id: "p-7", createdAt: "2026-07-29T00:00:00.000Z", status: "open" },
      ],
      events: [],
      heads: [],
      retrievals: [
        {
          id: "m-old",
          occurredAt: "2026-02-01T00:00:00.000Z",
          queryHash: "h1",
          resultCount: 1,
          durationMs: 5,
        },
        {
          id: "m-7",
          occurredAt: "2026-07-30T00:00:00.000Z",
          queryHash: "h2",
          resultCount: 3,
          durationMs: 9,
        },
      ],
    };

    const all = buildVaultDashboardSummary(input, asOf, "all");
    const ninety = buildVaultDashboardSummary(input, asOf, "90d");
    const thirty = buildVaultDashboardSummary(input, asOf, "30d");
    const seven = buildVaultDashboardSummary(input, asOf, "7d");

    // "all" is unwindowed and identical to the default (no range) call.
    expect(all).toEqual(buildVaultDashboardSummary(input, asOf));
    expect(all.growth.revisions).toBe(4);
    expect(all.retrieval.searches).toBe(2);
    expect(all.reviewThroughput.proposed).toBe(2);

    // Each narrower window drops the older events; current-state stays constant.
    expect(ninety.growth.revisions).toBe(3);
    expect(thirty.growth.revisions).toBe(2);
    expect(seven.growth.revisions).toBe(1);
    expect(seven.retrieval.searches).toBe(1);
    expect(seven.reviewThroughput.proposed).toBe(1);
    // Snapshot metrics (current pages) are never windowed.
    expect(seven.growth.acceptedPages).toBe(all.growth.acceptedPages);
    expect(seven.citationCoverage).toEqual(all.citationCoverage);
    expect(seven.connectivity).toEqual(all.connectivity);
  });

  it("buckets growth by acceptedAt, not createdAt, when they fall on different days", () => {
    const input: VaultAnalyticsInput = {
      pages: [],
      sourceCount: 0,
      // Drafted 2026-07-01, accepted 2026-07-05: growth must land on the ACCEPTANCE
      // day, since the documented metric is accepted-event-time.
      revisions: [
        {
          id: "r1",
          pageId: "alpha",
          createdAt: "2026-07-01T00:00:00.000Z",
          acceptedAt: "2026-07-05T00:00:00.000Z",
        },
        {
          id: "r2",
          pageId: "alpha",
          createdAt: "2026-07-02T00:00:00.000Z",
          acceptedAt: "2026-07-05T12:00:00.000Z",
        },
      ],
      proposals: [],
      events: [],
      heads: [],
      retrievals: [],
    };
    const summary = buildVaultDashboardSummary(
      input,
      "2026-08-01T00:00:00.000Z",
    );
    // A single acceptance-day bucket (07-05), with the page counted new on that day —
    // NOT split across the two authoring days (07-01 / 07-02).
    expect(summary.growth.daily).toEqual([
      { day: "2026-07-05", pages: 1, revisions: 2 },
    ]);
  });

  it("counts a page linked only via a dependency as connected, not an orphan", () => {
    const dependant: MemoryPage = {
      id: "dependant",
      path: "dependant.md",
      title: "Dependant",
      revision: 1,
      aliases: [],
      tags: [],
      sources: [],
      citations: [],
      relationships: [],
      body: "# Dependant\n\nDependant requires Target.\n",
      metadata: { citationPolicy: "none" },
    };
    const target: MemoryPage = {
      id: "target",
      path: "target.md",
      title: "Target",
      revision: 1,
      aliases: [],
      tags: [],
      sources: [],
      citations: [],
      relationships: [],
      body: "# Target\n\nAlso no wikilinks.\n",
      metadata: { citationPolicy: "none" },
    };
    const input: VaultAnalyticsInput = {
      pages: [dependant, target],
      sourceCount: 0,
      revisions: [],
      proposals: [],
      events: [],
      heads: [],
      retrievals: [],
      relationshipEvidence: [
        acceptedRelationship(
          dependant,
          target,
          "dependency",
          "Dependant requires Target.",
        ),
      ],
    };
    const summary = buildVaultDashboardSummary(
      input,
      "2026-08-01T00:00:00.000Z",
    );
    // The dependency edge connects BOTH endpoints — neither is an orphan, matching
    // the graph view's degree-based definition.
    expect(summary.health.orphanPages).toBe(0);
    expect(summary.connectivity.connectedPages).toBe(2);
    expect(summary.connectivity.directedLinks).toBe(1);
  });
});

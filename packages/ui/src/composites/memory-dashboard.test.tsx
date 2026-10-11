import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDashboard } from "./memory-dashboard.js";
import type { MemoryDashboardSummary } from "@jingler/contracts";

afterEach(cleanup);

const HEALTH_FINDINGS = /Health findings/;
const PAGE_BODY = /page body/i;

const summary: MemoryDashboardSummary = {
  version: 1,
  asOf: "2026-08-01T00:00:00.000Z",
  growth: {
    acceptedPages: 12,
    revisions: 18,
    sources: 7,
    daily: [{ day: "2026-08-01", pages: 2, revisions: 3 }],
  },
  citationCoverage: {
    citations: 20,
    citedPages: 10,
    totalPages: 12,
    ratio: 10 / 12,
  },
  freshness: { fresh: 8, aging: 2, stale: 2, unknown: 0 },
  health: { orphanPages: 1, brokenLinks: 2, contradictions: 1 },
  reviewThroughput: {
    proposed: 4,
    accepted: 2,
    rejected: 0,
    conflicted: 1,
    open: 1,
    acceptanceRatio: 2 / 3,
    medianReviewHours: 4,
  },
  connectivity: {
    pages: 12,
    directedLinks: 20,
    citationEdges: 30,
    durablePageEdges: 20,
    connectedPages: 11,
    averageDegree: 3.3,
  },
  retrieval: {
    searches: 9,
    reads: 7,
    navigation: 3,
    graphReads: 2,
    proposals: 1,
    zeroResultSearches: 1,
    zeroResultRatio: 1 / 9,
    resultsReturned: 24,
    uniqueQueryHashes: 8,
    medianDurationMs: 6,
    p95DurationMs: 10,
  },
  funnel: {
    transitions: 9,
    outcomes: [{ outcome: "published", count: 2 }],
    bySourceKind: [
      {
        sourceKind: "conversation",
        sources: 4,
        captured: 4,
        delivered: 3,
        proposals: 2,
        pendingReview: 1,
        published: 2,
        noDurableLearning: 0,
        conflicted: 0,
        rejected: 0,
        permanentFailures: 0,
        deliveryFailures: 1,
      },
    ],
  },
  quality: {
    window: "7d",
    startedAt: "2026-07-25T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:00.000Z",
    segments: [],
    totals: {
      reviewedCandidates: 3,
      durablePositiveCandidates: 3,
      submittedCandidates: 3,
      returnedHandles: 3,
      terminalPolls: 3,
      acceptedAsIs: 3,
      rejected: 0,
      nearDuplicates: 0,
      exactDuplicates: 0,
      sensitiveEscapes: 0,
      brokenEvidence: 0,
      sources: 4,
      deliveredSources: 3,
      terminalSources: 3,
      workflowErrors: 0,
      unexplainedSources: 0,
      proposals: 2,
      proposalRecall: 1,
      pollingCompleteness: 1,
      acceptAsIsRatio: 1,
      rejectionRatio: 0,
      nearDuplicateRatio: 0,
      terminalSettlementRatio: 1,
      unexplainedFunnelRatio: 0,
    },
  },
  rollout: { safeToExpand: true, stoppedArms: [], stops: [] },
};

describe("MemoryDashboard", () => {
  it("renders bounded summary data and deep-links quality cards", () => {
    const navigate = vi.fn();
    render(<MemoryDashboard summary={summary} onNavigate={navigate} />);
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("83%")).toBeDefined();
    expect(
      screen.getByText("20 durable page edges · 30 source citations"),
    ).toBeDefined();
    expect(
      screen.getByRole("row", { name: /conversation 4 3 2 2 0 1 0/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Delivery failures" }),
    ).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Compiler failures" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: HEALTH_FINDINGS }));
    expect(navigate).toHaveBeenCalledWith({ view: "map", filter: "unhealthy" });
    expect(screen.queryByText(PAGE_BODY)).toBeNull();
  });

  it("shows an automatic-stop warning with the affected arms", () => {
    render(
      <MemoryDashboard
        summary={{
          ...summary,
          rollout: {
            safeToExpand: false,
            stoppedArms: ["auto_publication"],
            stops: [
              {
                reason: "sensitive_escape",
                affectedArms: ["auto_publication"],
                observed: 1,
                threshold: 0,
              },
            ],
          },
        }}
        onNavigate={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Memory rollout automatically stopped"),
    ).toBeDefined();
    expect(screen.getByText(/auto publication remain disabled/)).toBeDefined();
  });
});

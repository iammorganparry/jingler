import {
  AGING_MAX_DAYS,
  FRESH_MAX_DAYS,
  buildMemoryGraphView,
  compareText,
  contradictionCount,
  extractCitationReferences,
  type MemoryAuditEvent,
  type MemoryPage,
  type MemoryProposalStatus,
  type MemoryRelationshipEvidence,
} from "@jingler/memory";
import type { MemoryRetrievalSummary } from "@jingler/core";
import type {
  MemoryFunnelOutcome,
  MemoryFunnelSourceKind,
  MemoryFunnelTransition,
  MemoryQualityCounters,
  MemoryRolloutArm,
  MemoryRolloutHarness,
  MemorySessionLengthCohort,
} from "@jingler/core";

export interface VaultAnalyticsRevision {
  readonly id: string;
  readonly pageId: string;
  readonly createdAt: string;
  /**
   * When the revision was ACCEPTED (committed to the head). The growth series and
   * the range window key off this — the documented metric is accepted-event-time,
   * not authoring time — so a revision drafted one day and accepted the next lands
   * on the day it actually entered the vault.
   */
  readonly acceptedAt: string;
}

export interface VaultAnalyticsProposal {
  readonly id: string;
  readonly createdAt: string;
  readonly status: MemoryProposalStatus;
}

export interface VaultPageHeadActivity {
  readonly pageId: string;
  readonly acceptedAt: string;
}

export interface RetrievalMetric {
  readonly id: string;
  readonly occurredAt: string;
  readonly queryHash: string;
  readonly resultCount: number;
  readonly durationMs: number;
}

export interface SessionRetrievalMetric extends MemoryRetrievalSummary {
  readonly id: string;
  readonly occurredAt: string;
}

export interface VaultAnalyticsInput {
  readonly pages: ReadonlyArray<MemoryPage>;
  readonly sourceCount: number;
  readonly revisions: ReadonlyArray<VaultAnalyticsRevision>;
  readonly proposals: ReadonlyArray<VaultAnalyticsProposal>;
  readonly events: ReadonlyArray<MemoryAuditEvent>;
  readonly heads: ReadonlyArray<VaultPageHeadActivity>;
  readonly retrievals: ReadonlyArray<RetrievalMetric>;
  readonly sessionRetrievals?: ReadonlyArray<SessionRetrievalMetric>;
  readonly funnelTransitions?: ReadonlyArray<MemoryFunnelTransition>;
  readonly relationshipEvidence?: ReadonlyArray<MemoryRelationshipEvidence>;
}

export interface DailyGrowth {
  readonly day: string;
  readonly pages: number;
  readonly revisions: number;
}

export interface VaultDashboardSummary {
  readonly version: 1;
  readonly asOf: string;
  readonly growth: {
    readonly acceptedPages: number;
    readonly revisions: number;
    readonly sources: number;
    readonly daily: ReadonlyArray<DailyGrowth>;
  };
  readonly citationCoverage: {
    readonly citations: number;
    readonly citedPages: number;
    readonly totalPages: number;
    readonly ratio: number;
  };
  readonly freshness: {
    readonly fresh: number;
    readonly aging: number;
    readonly stale: number;
    readonly unknown: number;
  };
  readonly health: {
    readonly orphanPages: number;
    readonly brokenLinks: number;
    readonly contradictions: number;
  };
  readonly reviewThroughput: {
    readonly proposed: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly conflicted: number;
    readonly open: number;
    readonly acceptanceRatio: number;
    readonly medianReviewHours: number | null;
  };
  readonly connectivity: {
    readonly pages: number;
    readonly directedLinks: number;
    readonly citationEdges: number;
    readonly durablePageEdges: number;
    readonly connectedPages: number;
    readonly averageDegree: number;
  };
  readonly retrieval: {
    readonly searches: number;
    readonly reads: number;
    readonly navigation: number;
    readonly graphReads: number;
    readonly proposals: number;
    readonly zeroResultSearches: number;
    readonly zeroResultRatio: number;
    readonly resultsReturned: number;
    readonly uniqueQueryHashes: number;
    readonly medianDurationMs: number | null;
    readonly p95DurationMs: number | null;
  };
  readonly funnel: {
    readonly transitions: number;
    readonly outcomes: ReadonlyArray<{
      readonly outcome: MemoryFunnelOutcome;
      readonly count: number;
    }>;
    readonly bySourceKind: ReadonlyArray<{
      readonly sourceKind: MemoryFunnelSourceKind;
      readonly sources: number;
      readonly captured: number;
      readonly delivered: number;
      readonly proposals: number;
      readonly pendingReview: number;
      readonly published: number;
      readonly noDurableLearning: number;
      readonly conflicted: number;
      readonly rejected: number;
      readonly permanentFailures: number;
      readonly deliveryFailures: number;
    }>;
  };
  readonly quality: MemoryWeeklyQualityReport;
  readonly rollout: MemoryRolloutHealth;
}

export interface MemoryQualityMetrics extends MemoryQualityCounters {
  readonly sources: number;
  readonly deliveredSources: number;
  readonly terminalSources: number;
  readonly workflowErrors: number;
  readonly unexplainedSources: number;
  readonly proposals: number;
  readonly proposalRecall: number;
  readonly pollingCompleteness: number;
  readonly acceptAsIsRatio: number;
  readonly rejectionRatio: number;
  readonly nearDuplicateRatio: number;
  readonly terminalSettlementRatio: number;
  readonly unexplainedFunnelRatio: number;
}

export interface MemoryWeeklyQualitySegment extends MemoryQualityMetrics {
  readonly harness: MemoryRolloutHarness;
  readonly sourceKind: MemoryFunnelSourceKind;
  readonly experimentArm: MemoryRolloutArm;
  readonly sessionLengthCohort: MemorySessionLengthCohort;
}

export interface MemoryWeeklyQualityReport {
  readonly window: "7d";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly segments: ReadonlyArray<MemoryWeeklyQualitySegment>;
  readonly totals: MemoryQualityMetrics;
}

export type MemoryRolloutStopReason =
  | "sensitive_escape"
  | "workflow_errors"
  | "rejection"
  | "duplication"
  | "broken_evidence"
  | "unexplained_funnel_delta";

export interface MemoryRolloutStop {
  readonly reason: MemoryRolloutStopReason;
  readonly affectedArms: ReadonlyArray<MemoryRolloutArm>;
  readonly observed: number;
  readonly threshold: number;
}

export interface MemoryRolloutHealth {
  readonly safeToExpand: boolean;
  readonly stoppedArms: ReadonlyArray<MemoryRolloutArm>;
  readonly stops: ReadonlyArray<MemoryRolloutStop>;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The dashboard's time-range control. `"all"` (and any unrecognized value) means
 * unwindowed — every time-scoped series is aggregated over all of history.
 */
export type DashboardRange = "7d" | "30d" | "90d" | "all";

const RANGE_DAYS: Readonly<Record<string, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * Window only the inherently time-series inputs (revisions, proposals, events,
 * retrievals, session retrievals) to `[asOf - range, asOf]`. The current-state
 * inputs (pages, heads, sourceCount) are a snapshot and are never windowed, so
 * coverage/freshness/health/connectivity always describe the vault as it stands.
 * `"all"` — or an unparseable range/asOf — returns the input untouched.
 */
const windowAnalyticsInput = (
  input: VaultAnalyticsInput,
  asOf: string,
  range: string,
): VaultAnalyticsInput => {
  const days = RANGE_DAYS[range];
  if (days === undefined) return input;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return input;
  const cutoff = asOfMs - days * MILLISECONDS_PER_DAY;
  const within = (timestamp: string): boolean => {
    const value = Date.parse(timestamp);
    return Number.isFinite(value) && value >= cutoff && value <= asOfMs;
  };
  return {
    ...input,
    revisions: input.revisions.filter((revision) =>
      within(revision.acceptedAt),
    ),
    proposals: input.proposals.filter((proposal) => within(proposal.createdAt)),
    events: input.events.filter((event) => within(event.occurredAt)),
    retrievals: input.retrievals.filter((metric) => within(metric.occurredAt)),
    ...(input.sessionRetrievals === undefined
      ? {}
      : {
          sessionRetrievals: input.sessionRetrievals.filter((metric) =>
            within(metric.occurredAt),
          ),
        }),
    ...(input.funnelTransitions === undefined
      ? {}
      : {
          funnelTransitions: input.funnelTransitions.filter((transition) =>
            within(transition.occurredAt),
          ),
        }),
  };
};
const rounded = (value: number): number => Math.round(value * 10_000) / 10_000;

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : rounded(numerator / denominator);

const dayOf = (timestamp: string): string => timestamp.slice(0, 10);

const percentile = (
  values: ReadonlyArray<number>,
  position: number,
): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(position * sorted.length) - 1),
  );
  return sorted[index] ?? null;
};

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
};

const freshnessCounts = (
  pages: ReadonlyArray<MemoryPage>,
  heads: ReadonlyArray<VaultPageHeadActivity>,
  asOf: string,
): VaultDashboardSummary["freshness"] => {
  const acceptedAt = new Map(
    heads.map((head) => [head.pageId, head.acceptedAt]),
  );
  const counts = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const page of pages) {
    const timestamp = acceptedAt.get(page.id);
    const age =
      timestamp === undefined
        ? Number.NaN
        : Date.parse(asOf) - Date.parse(timestamp);
    if (!Number.isFinite(age)) counts.unknown += 1;
    else if (age / MILLISECONDS_PER_DAY <= FRESH_MAX_DAYS) counts.fresh += 1;
    else if (age / MILLISECONDS_PER_DAY <= AGING_MAX_DAYS) counts.aging += 1;
    else counts.stale += 1;
  }
  return counts;
};

const growthSeries = (
  revisions: ReadonlyArray<VaultAnalyticsRevision>,
): ReadonlyArray<DailyGrowth> => {
  // Key every bucket off acceptedAt: growth is an accepted-event-time series, so a
  // page counts as "new" on the day its first revision was accepted, and each
  // revision counts on its own acceptance day.
  const pageFirstRevision = new Map<string, VaultAnalyticsRevision>();
  for (const revision of [...revisions].sort((left, right) =>
    compareText(left.acceptedAt, right.acceptedAt),
  )) {
    if (!pageFirstRevision.has(revision.pageId))
      pageFirstRevision.set(revision.pageId, revision);
  }
  const counts = new Map<string, { pages: number; revisions: number }>();
  for (const revision of revisions) {
    const day = dayOf(revision.acceptedAt);
    const current = counts.get(day) ?? { pages: 0, revisions: 0 };
    current.revisions += 1;
    counts.set(day, current);
  }
  for (const revision of pageFirstRevision.values()) {
    const day = dayOf(revision.acceptedAt);
    const current = counts.get(day) ?? { pages: 0, revisions: 0 };
    current.pages += 1;
    counts.set(day, current);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([day, count]) => ({ day, ...count }));
};

const connectivity = (
  pages: ReadonlyArray<MemoryPage>,
  relationshipEvidence: ReadonlyArray<MemoryRelationshipEvidence>,
): {
  readonly directedLinks: number;
  readonly citationEdges: number;
  readonly connectedPages: number;
  readonly orphanPages: number;
  readonly brokenLinks: number;
} => {
  // Derive connectivity from the SAME (tolerant) graph edge set the graph view uses,
  // so the dashboard and the graph agree on orphans: a page linked only via a
  // dependency, citation, or schema relationship counts as connected here too, not
  // just via wikilinks. Broken-wikilink counts come from the same pass.
  const { graph, brokenWikiLinksByPage } = buildMemoryGraphView(
    pages,
    [],
    relationshipEvidence,
  );
  const pageNodeIds = new Set(pages.map((page) => `page:${page.id}`));
  const connected = new Set<string>();
  let directedLinks = 0;
  const citationEdges = pages.reduce(
    (total, page) => total + extractCitationReferences(page.body).length,
    0,
  );
  for (const edge of graph.edges) {
    // "directedLinks" is forward page→page references (wikilink + dependency);
    // backlinks are their mirror and citation/schema edges leave the page graph.
    if (
      (edge.kind === "wikilink" || edge.kind === "dependency") &&
      pageNodeIds.has(edge.targetId)
    ) {
      directedLinks += 1;
      connected.add(edge.sourceId);
      connected.add(edge.targetId);
    }
  }
  const brokenLinks = [...brokenWikiLinksByPage.values()].reduce(
    (total, count) => total + count,
    0,
  );
  return {
    directedLinks,
    citationEdges,
    connectedPages: connected.size,
    orphanPages: pages.length - connected.size,
    brokenLinks,
  };
};

const reviewDurations = (
  proposals: ReadonlyArray<VaultAnalyticsProposal>,
  events: ReadonlyArray<MemoryAuditEvent>,
): ReadonlyArray<number> => {
  const proposedAt = new Map(
    proposals.map((proposal) => [proposal.id, proposal.createdAt]),
  );
  return events
    .filter(
      (event) =>
        (event.type === "proposal.accepted" ||
          event.type === "proposal.rejected") &&
        event.proposalId !== undefined,
    )
    .map((event) => {
      const createdAt =
        event.proposalId === undefined
          ? undefined
          : proposedAt.get(event.proposalId);
      return createdAt === undefined
        ? Number.NaN
        : Date.parse(event.occurredAt) - Date.parse(createdAt);
    })
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
    .map((duration) => duration / 3_600_000);
};

const funnelSummary = (
  transitions: ReadonlyArray<MemoryFunnelTransition>,
): VaultDashboardSummary["funnel"] => {
  const counts = new Map<MemoryFunnelOutcome, number>();
  const kinds = new Map<
    MemoryFunnelSourceKind,
    Array<MemoryFunnelTransition>
  >();
  for (const transition of transitions) {
    counts.set(transition.outcome, (counts.get(transition.outcome) ?? 0) + 1);
    const current = kinds.get(transition.sourceKind) ?? [];
    current.push(transition);
    kinds.set(transition.sourceKind, current);
  }
  const count = (
    values: ReadonlyArray<MemoryFunnelTransition>,
    outcome: MemoryFunnelOutcome,
  ): number =>
    values.filter((transition) => transition.outcome === outcome).length;
  return {
    transitions: transitions.length,
    outcomes: [...counts.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([outcome, value]) => ({ outcome, count: value })),
    bySourceKind: [...kinds.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([sourceKind, values]) => ({
        sourceKind,
        sources: new Set(values.map((transition) => transition.sourceId)).size,
        captured: count(values, "captured"),
        delivered: count(values, "delivered"),
        proposals: count(values, "proposal_created"),
        pendingReview: count(values, "pending_review"),
        published: count(values, "published"),
        noDurableLearning: count(values, "no_durable_learning"),
        conflicted: count(values, "conflict"),
        rejected: count(values, "rejected"),
        permanentFailures: count(values, "permanent_failure"),
        deliveryFailures:
          count(values, "delivery_failed") +
          count(values, "delivery_expired") +
          count(values, "membership_dropped"),
      })),
  };
};

const EMPTY_QUALITY_COUNTERS: MemoryQualityCounters = {
  reviewedCandidates: 0,
  durablePositiveCandidates: 0,
  submittedCandidates: 0,
  returnedHandles: 0,
  terminalPolls: 0,
  acceptedAsIs: 0,
  rejected: 0,
  nearDuplicates: 0,
  exactDuplicates: 0,
  sensitiveEscapes: 0,
  brokenEvidence: 0,
};

const TERMINAL_OUTCOMES = new Set<MemoryFunnelOutcome>([
  "pending_review",
  "published",
  "no_durable_learning",
  "extraction_shadowed",
  "rollout_stopped",
  "conflict",
  "rejected",
  "permanent_failure",
  "infrastructure_failure",
]);

const sumQuality = (
  transitions: ReadonlyArray<MemoryFunnelTransition>,
): MemoryQualityCounters =>
  transitions.reduce<MemoryQualityCounters>((total, transition) => {
    const quality = transition.quality;
    if (quality === undefined) return total;
    return {
      reviewedCandidates: total.reviewedCandidates + quality.reviewedCandidates,
      durablePositiveCandidates:
        total.durablePositiveCandidates + quality.durablePositiveCandidates,
      submittedCandidates:
        total.submittedCandidates + quality.submittedCandidates,
      returnedHandles: total.returnedHandles + quality.returnedHandles,
      terminalPolls: total.terminalPolls + quality.terminalPolls,
      acceptedAsIs: total.acceptedAsIs + quality.acceptedAsIs,
      rejected: total.rejected + quality.rejected,
      nearDuplicates: total.nearDuplicates + quality.nearDuplicates,
      exactDuplicates: total.exactDuplicates + quality.exactDuplicates,
      sensitiveEscapes: total.sensitiveEscapes + quality.sensitiveEscapes,
      brokenEvidence: total.brokenEvidence + quality.brokenEvidence,
    };
  }, EMPTY_QUALITY_COUNTERS);

const qualityMetrics = (
  transitions: ReadonlyArray<MemoryFunnelTransition>,
): MemoryQualityMetrics => {
  const sourceIds = new Set(
    transitions.map((transition) => transition.sourceId),
  );
  const deliveredIds = new Set(
    transitions
      .filter((transition) => transition.outcome === "delivered")
      .map((transition) => transition.sourceId),
  );
  const terminalIds = new Set(
    transitions
      .filter((transition) => TERMINAL_OUTCOMES.has(transition.outcome))
      .map((transition) => transition.sourceId),
  );
  const errorIds = new Set(
    transitions
      .filter(
        (transition) =>
          transition.outcome === "permanent_failure" ||
          transition.outcome === "infrastructure_failure",
      )
      .map((transition) => transition.sourceId),
  );
  const settledDelivered = [...deliveredIds].filter((sourceId) =>
    terminalIds.has(sourceId),
  ).length;
  const quality = sumQuality(transitions);
  const unexplainedSources = Math.max(0, deliveredIds.size - settledDelivered);
  return {
    ...quality,
    sources: sourceIds.size,
    deliveredSources: deliveredIds.size,
    terminalSources: settledDelivered,
    workflowErrors: errorIds.size,
    unexplainedSources,
    proposals: transitions.filter(
      (transition) => transition.outcome === "proposal_created",
    ).length,
    proposalRecall: ratio(
      quality.submittedCandidates,
      quality.durablePositiveCandidates,
    ),
    pollingCompleteness: ratio(quality.terminalPolls, quality.returnedHandles),
    acceptAsIsRatio: ratio(quality.acceptedAsIs, quality.reviewedCandidates),
    rejectionRatio: ratio(quality.rejected, quality.reviewedCandidates),
    nearDuplicateRatio: ratio(
      quality.nearDuplicates,
      quality.reviewedCandidates,
    ),
    terminalSettlementRatio: ratio(settledDelivered, deliveredIds.size),
    unexplainedFunnelRatio: ratio(unexplainedSources, deliveredIds.size),
  };
};

const rolloutOf = (
  transitions: ReadonlyArray<MemoryFunnelTransition>,
): Map<string, NonNullable<MemoryFunnelTransition["rollout"]>> => {
  const bySource = new Map<
    string,
    NonNullable<MemoryFunnelTransition["rollout"]>
  >();
  for (const transition of transitions) {
    if (transition.rollout !== undefined)
      bySource.set(transition.sourceId, transition.rollout);
  }
  return bySource;
};

export const buildWeeklyQualityReport = (
  transitions: ReadonlyArray<MemoryFunnelTransition>,
  asOf: string,
): MemoryWeeklyQualityReport => {
  const endedAtMs = Date.parse(asOf);
  const startedAtMs = Number.isFinite(endedAtMs)
    ? endedAtMs - 7 * MILLISECONDS_PER_DAY
    : Number.NEGATIVE_INFINITY;
  const weekly = transitions.filter((transition) => {
    const occurredAt = Date.parse(transition.occurredAt);
    return (
      Number.isFinite(occurredAt) &&
      occurredAt >= startedAtMs &&
      occurredAt <= endedAtMs
    );
  });
  const assignments = rolloutOf(weekly);
  const grouped = new Map<
    string,
    {
      key: Omit<MemoryWeeklyQualitySegment, keyof MemoryQualityMetrics>;
      values: MemoryFunnelTransition[];
    }
  >();
  for (const transition of weekly) {
    const rollout = transition.rollout ?? assignments.get(transition.sourceId);
    const arms = rollout?.arms ?? (["control"] as const);
    for (const experimentArm of arms) {
      const key = {
        harness: rollout?.harness ?? ("unknown" as const),
        sourceKind: transition.sourceKind,
        experimentArm,
        sessionLengthCohort:
          rollout?.sessionLengthCohort ?? ("unknown" as const),
      };
      const id = `${key.harness}\u0000${key.sourceKind}\u0000${key.experimentArm}\u0000${key.sessionLengthCohort}`;
      const group = grouped.get(id) ?? { key, values: [] };
      group.values.push(transition);
      grouped.set(id, group);
    }
  }
  return {
    window: "7d",
    startedAt: Number.isFinite(startedAtMs)
      ? new Date(startedAtMs).toISOString()
      : asOf,
    endedAt: asOf,
    segments: [...grouped.values()]
      .sort((left, right) =>
        compareText(JSON.stringify(left.key), JSON.stringify(right.key)),
      )
      .map(({ key, values }) => ({ ...key, ...qualityMetrics(values) })),
    totals: qualityMetrics(weekly),
  };
};

export const evaluateMemoryRolloutHealth = (
  report: MemoryWeeklyQualityReport,
): MemoryRolloutHealth => {
  const metrics = report.totals;
  const stops: MemoryRolloutStop[] = [];
  const stop = (
    reason: MemoryRolloutStopReason,
    affectedArms: ReadonlyArray<MemoryRolloutArm>,
    observed: number,
    threshold: number,
  ): void => {
    stops.push({
      reason,
      affectedArms,
      observed: rounded(observed),
      threshold,
    });
  };
  const creationArms: ReadonlyArray<MemoryRolloutArm> = [
    "reflection",
    "extraction_shadow",
    "extraction_review",
    "auto_publication",
  ];
  if (metrics.sensitiveEscapes > 0)
    stop("sensitive_escape", creationArms, metrics.sensitiveEscapes, 0);
  if (
    metrics.deliveredSources >= 20 &&
    ratio(metrics.workflowErrors, metrics.deliveredSources) > 0.01
  ) {
    stop(
      "workflow_errors",
      ["extraction_shadow", "extraction_review", "auto_publication"],
      ratio(metrics.workflowErrors, metrics.deliveredSources),
      0.01,
    );
  }
  if (metrics.reviewedCandidates >= 20 && metrics.rejectionRatio > 0.15) {
    stop("rejection", creationArms, metrics.rejectionRatio, 0.15);
  }
  if (
    metrics.reviewedCandidates >= 20 &&
    (metrics.nearDuplicateRatio > 0.02 || metrics.exactDuplicates > 0)
  ) {
    stop(
      "duplication",
      ["extraction_review", "auto_publication"],
      Math.max(metrics.nearDuplicateRatio, metrics.exactDuplicates),
      0.02,
    );
  }
  if (metrics.brokenEvidence > 0) {
    stop(
      "broken_evidence",
      ["extraction_review", "auto_publication", "relationship_review"],
      metrics.brokenEvidence,
      0,
    );
  }
  if (metrics.deliveredSources > 0 && metrics.unexplainedFunnelRatio > 0.01) {
    stop(
      "unexplained_funnel_delta",
      ["extraction_shadow", "extraction_review", "auto_publication"],
      metrics.unexplainedFunnelRatio,
      0.01,
    );
  }
  const stoppedArms = [
    ...new Set(stops.flatMap(({ affectedArms }) => affectedArms)),
  ].sort(compareText);
  return { safeToExpand: stops.length === 0, stoppedArms, stops };
};

export const buildVaultDashboardSummary = (
  rawInput: VaultAnalyticsInput,
  asOf: string,
  range: string = "all",
): VaultDashboardSummary => {
  const input = windowAnalyticsInput(rawInput, asOf, range);
  const quality = buildWeeklyQualityReport(
    rawInput.funnelTransitions ?? [],
    asOf,
  );
  const citationsByPage = input.pages.map(
    (page) => extractCitationReferences(page.body).length,
  );
  const links = connectivity(input.pages, input.relationshipEvidence ?? []);
  const accepted = input.proposals.filter(
    (proposal) => proposal.status === "accepted",
  ).length;
  const rejected = input.proposals.filter(
    (proposal) => proposal.status === "rejected",
  ).length;
  const conflicted = input.proposals.filter(
    (proposal) => proposal.status === "superseded",
  ).length;
  const open = input.proposals.filter(
    (proposal) => proposal.status === "open",
  ).length;
  const durations = reviewDurations(input.proposals, input.events);
  const resultCount = input.retrievals.reduce(
    (total, metric) => total + metric.resultCount,
    0,
  );
  const zeroResults = input.retrievals.filter(
    (metric) => metric.resultCount === 0,
  ).length;
  const captured = (
    input.sessionRetrievals ?? []
  ).reduce<MemoryRetrievalSummary>(
    (total, metric) => ({
      searches: total.searches + metric.searches,
      reads: total.reads + metric.reads,
      navigation: total.navigation + metric.navigation,
      graphReads: total.graphReads + metric.graphReads,
      proposals: total.proposals + metric.proposals,
    }),
    { searches: 0, reads: 0, navigation: 0, graphReads: 0, proposals: 0 },
  );
  return {
    version: 1,
    asOf,
    growth: {
      acceptedPages: input.pages.length,
      revisions: input.revisions.length,
      sources: input.sourceCount,
      daily: growthSeries(input.revisions),
    },
    citationCoverage: {
      citations: citationsByPage.reduce((total, count) => total + count, 0),
      citedPages: citationsByPage.filter((count) => count > 0).length,
      totalPages: input.pages.length,
      ratio: ratio(
        citationsByPage.filter((count) => count > 0).length,
        input.pages.length,
      ),
    },
    freshness: freshnessCounts(input.pages, input.heads, asOf),
    health: {
      orphanPages: links.orphanPages,
      brokenLinks: links.brokenLinks,
      contradictions: input.pages.reduce(
        (total, page) => total + contradictionCount(page),
        0,
      ),
    },
    reviewThroughput: {
      proposed: input.proposals.length,
      accepted,
      rejected,
      conflicted,
      open,
      acceptanceRatio: ratio(accepted, accepted + rejected + conflicted),
      medianReviewHours: median(durations),
    },
    connectivity: {
      pages: input.pages.length,
      directedLinks: links.directedLinks,
      citationEdges: links.citationEdges,
      durablePageEdges: links.directedLinks,
      connectedPages: links.connectedPages,
      averageDegree:
        input.pages.length === 0
          ? 0
          : rounded((links.directedLinks * 2) / input.pages.length),
    },
    retrieval: {
      searches: input.retrievals.length + captured.searches,
      reads: captured.reads,
      navigation: captured.navigation,
      graphReads: captured.graphReads,
      proposals: captured.proposals,
      zeroResultSearches: zeroResults,
      zeroResultRatio: ratio(zeroResults, input.retrievals.length),
      resultsReturned: resultCount,
      uniqueQueryHashes: new Set(
        input.retrievals.map((metric) => metric.queryHash),
      ).size,
      medianDurationMs: median(
        input.retrievals.map((metric) => metric.durationMs),
      ),
      p95DurationMs: percentile(
        input.retrievals.map((metric) => metric.durationMs),
        0.95,
      ),
    },
    funnel: funnelSummary(input.funnelTransitions ?? []),
    quality,
    rollout: evaluateMemoryRolloutHealth(quality),
  };
};

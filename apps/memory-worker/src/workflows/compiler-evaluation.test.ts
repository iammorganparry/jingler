import { Schema } from "effect"
import {
  MemoryCompilerCandidateResult as MemoryCompilerCandidateResultSchema,
  type MemoryCompilerCandidate
} from "@jingler/memory"
import { describe, expect, it } from "vitest"
import {
  MEMORY_CREATION_CORPUS,
  MEMORY_CREATION_ROLLOUT_GUARDRAILS,
  type MemoryCreationCorpusCase,
  type MemoryCreationExpectedCandidate
} from "../testing/memory-creation-corpus.js"
import {
  DeterministicCompilerModel,
  extractCompilerClaimEvidence,
  selectCompilerCandidates,
  type CompilerContext
} from "./compiler.js"

interface EvaluationReport {
  readonly cases: number
  readonly expectedCandidates: number
  readonly emittedCandidates: number
  readonly candidateRecall: number
  readonly candidatePrecision: number
  readonly targetAccuracy: number
  readonly duplicateRate: number
  readonly sensitivityEscapes: number
  readonly privacyEscapes: number
}

const normalizedProse = (value: string): string =>
  (value.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")

interface EvaluatedFixture {
  readonly fixture: MemoryCreationCorpusCase
  readonly actual: ReadonlyArray<MemoryCompilerCandidate>
}

const evaluateFixture = async (fixture: MemoryCreationCorpusCase): Promise<EvaluatedFixture> => {
  const claimEvidence = extractCompilerClaimEvidence(fixture.content)
  const context: CompilerContext = {
    organizationId: "org-redacted-evaluation",
    source: fixture.source,
    claims: claimEvidence.map(({ claim }) => claim),
    claimEvidence,
    schemaPages: [],
    candidates: selectCompilerCandidates(
      fixture.acceptedPages,
      claimEvidence.map(({ claim }) => claim)
    ),
    indexMarkdown: "# Redacted evaluation"
  }
  const result = Schema.decodeUnknownSync(MemoryCompilerCandidateResultSchema)(
    await new DeterministicCompilerModel().generate({
      context,
      prompt: "fixed redacted compiler evaluation"
    })
  )
  return {
    fixture,
    actual: result.status === "candidates" ? result.candidates : []
  }
}

const matchingCandidate = (
  actual: ReadonlyArray<MemoryCompilerCandidate>,
  expected: MemoryCreationExpectedCandidate
): MemoryCompilerCandidate | undefined => actual.find((candidate) => candidate.claim === expected.claim)

const isDuplicate = ({ fixture, candidate }: EvaluatedFixture & { readonly candidate: MemoryCompilerCandidate }) =>
  fixture.acceptedPages.some(({ page }) =>
    normalizedProse(page.body).includes(normalizedProse(candidate.claim))
  )

const isPrivacyEscape = ({
  fixture,
  candidate
}: EvaluatedFixture & { readonly candidate: MemoryCompilerCandidate }) =>
  fixture.forbiddenFragments.some((fragment) =>
    `${candidate.claim}\n${candidate.evidence.quote}`
      .toLocaleLowerCase("en-US")
      .includes(fragment.toLocaleLowerCase("en-US"))
  )

const evaluateCorpus = async (): Promise<EvaluationReport> => {
  const evaluated = await Promise.all(MEMORY_CREATION_CORPUS.map(evaluateFixture))
  const expectedEntries = evaluated.flatMap(({ fixture, actual }) =>
    fixture.expectedCandidates.map((expected) => ({ expected, candidate: matchingCandidate(actual, expected) }))
  )
  const actualEntries = evaluated.flatMap((entry) =>
    entry.actual.map((candidate) => ({ ...entry, candidate }))
  )
  const expectedCandidates = expectedEntries.length
  const emittedCandidates = actualEntries.length
  const recalled = expectedEntries.filter(({ candidate }) => candidate !== undefined).length
  const precise = actualEntries.filter(({ fixture, candidate }) =>
    fixture.expectedCandidates.some(
      (expected) => expected.claim === candidate.claim && expected.action === candidate.targetIdentity.action
    )
  ).length
  const correctTargets = expectedEntries.filter(
    ({ expected, candidate }) => candidate?.targetIdentity.action === expected.action
  ).length
  const sensitivityEscapes = expectedEntries.filter(
    ({ expected, candidate }) =>
      expected.sensitivity !== "standard" && candidate?.sensitivity === "standard"
  ).length
  const duplicates = actualEntries.filter(isDuplicate).length
  const privacyEscapes = actualEntries.filter(isPrivacyEscape).length

  return {
    cases: MEMORY_CREATION_CORPUS.length,
    expectedCandidates,
    emittedCandidates,
    candidateRecall: expectedCandidates === 0 ? 1 : recalled / expectedCandidates,
    candidatePrecision: emittedCandidates === 0 ? 1 : precise / emittedCandidates,
    targetAccuracy: expectedCandidates === 0 ? 1 : correctTargets / expectedCandidates,
    duplicateRate: emittedCandidates === 0 ? 0 : duplicates / emittedCandidates,
    sensitivityEscapes,
    privacyEscapes
  }
}

describe("redacted memory-creation corpus", () => {
  it("reports metrics above every review-rollout guardrail", async () => {
    const report = await evaluateCorpus()

    expect(report).toEqual({
      cases: 17,
      expectedCandidates: 11,
      emittedCandidates: 11,
      candidateRecall: 1,
      candidatePrecision: 1,
      targetAccuracy: 1,
      duplicateRate: 0,
      sensitivityEscapes: 0,
      privacyEscapes: 0
    })
    expect(report.candidateRecall).toBeGreaterThanOrEqual(
      MEMORY_CREATION_ROLLOUT_GUARDRAILS.minimumCandidateRecall
    )
    expect(report.candidatePrecision).toBeGreaterThanOrEqual(
      MEMORY_CREATION_ROLLOUT_GUARDRAILS.minimumCandidatePrecision
    )
    expect(report.duplicateRate).toBeLessThanOrEqual(
      MEMORY_CREATION_ROLLOUT_GUARDRAILS.maximumDuplicateRate
    )
    expect(report.sensitivityEscapes).toBeLessThanOrEqual(
      MEMORY_CREATION_ROLLOUT_GUARDRAILS.maximumSensitivityEscapes
    )
    expect(report.privacyEscapes).toBe(0)
  })
})

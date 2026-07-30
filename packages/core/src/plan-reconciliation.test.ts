import { describe, expect, it } from "vitest"
import type { PlanDocument } from "./plan-document.js"
import { parsePlanHtml } from "./plan-html.js"
import {
  planStageSemanticFingerprint,
  reconcilePlanAmendment
} from "./plan-reconciliation.js"

const documentFrom = (source: string): PlanDocument => {
  const parsed = parsePlanHtml(source)
  if (!parsed.valid) throw new Error("Test plan must be valid")
  return {
    id: "plan-1",
    sessionId: "session-1",
    producingChatId: "chat-1",
    revision: 3,
    status: "executing",
    source: parsed.html,
    projection: parsed.projection,
    updatedAt: "2026-07-29T12:00:00.000Z",
    updatedBy: "agent"
  }
}

const assignment = (
  agentId: string,
  status: "queued" | "running" | "completed"
): string =>
  `<div data-assignment data-agent-id="${agentId}" data-cli="codex" data-model="gpt-5" data-reason="Stable component owner." data-status="${status}"></div><ul data-files></ul>`

describe("reconcilePlanAmendment", () => {
  it("resets evidence for a changed running stage and preserves its existing assignee", () => {
    const previous = documentFrom(`<h1>PRD: Amend safely</h1>
<section data-stage="01" data-title="Worker stage" data-complexity="high">
${assignment("worker-a", "running")}
<p>Original implementation detail.</p>
<div data-acceptance="01.1" data-status="passed" data-evidence="unit test green">The stable behavior works.</div>
</section>`)
    const replacement = `<h1>PRD: Amend safely</h1>
<section data-stage="01" data-title="Worker stage" data-complexity="high">
${assignment("worker-b", "queued")}
<p>New user requirement for the same component.</p>
<div data-acceptance="01.1" data-status="pending">The stable behavior works.</div>
<div data-acceptance="01.2" data-status="passed" data-evidence="unverified">The added behavior works.</div>
</section>`

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    const stage = result.projection.stages[0]!
    expect(stage.assignment?.agentId).toBe("worker-a")
    expect(stage.executionStatus).toBe("running")
    expect(stage.acceptance).toEqual([
      {
        id: "01.1",
        text: "The stable behavior works.",
        status: "pending",
        evidence: null
      },
      {
        id: "01.2",
        text: "The added behavior works.",
        status: "pending",
        evidence: null
      }
    ])
    expect(result.changedStageIds).toEqual(["01"])
    const authoritative = parsePlanHtml(result.source)
    expect(authoritative.valid).toBe(true)
    if (authoritative.valid) expect(authoritative.projection).toEqual(result.projection)
  })

  it("reopens a changed completed stage while leaving an unchanged completed stage intact", () => {
    const previous = documentFrom(`<h1>PRD: Reopen changed work</h1>
<section data-stage="01" data-title="Changed" data-complexity="medium">
${assignment("worker-a", "completed")}
<div data-acceptance="01.1" data-status="passed" data-evidence="old assertion">The old behavior works.</div>
</section>
<section data-stage="02" data-title="Unchanged" data-complexity="low">
${assignment("worker-b", "completed")}
<div data-acceptance="02.1" data-status="passed" data-evidence="still green">The stable behavior works.</div>
</section>`)
    const replacement = `<h1>PRD: Reopen changed work</h1>
<section data-stage="01" data-title="Changed" data-complexity="high">
${assignment("replacement-owner", "completed")}
<div data-acceptance="01.1" data-status="passed" data-evidence="must be discarded">The revised behavior works.</div>
</section>
<section data-stage="02" data-title="Unchanged" data-complexity="low">
${assignment("replacement-owner-2", "queued")}
<div data-acceptance="02.1" data-status="pending">The stable behavior works.</div>
</section>`

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    const changed = result.projection.stages[0]!
    expect(changed.assignment?.agentId).toBe("worker-a")
    expect(changed.executionStatus).toBe("queued")
    expect(changed.acceptance[0]).toMatchObject({
      text: "The revised behavior works.",
      status: "pending",
      evidence: null
    })

    const unchanged = result.projection.stages[1]!
    expect(unchanged.assignment?.agentId).toBe("worker-b")
    expect(unchanged.executionStatus).toBe("completed")
    expect(unchanged.acceptance[0]).toMatchObject({
      status: "passed",
      evidence: "still green"
    })
    expect(result.changedStageIds).toEqual(["01"])
  })

  it("rejects removing a stage while its worker is running", () => {
    const previous = documentFrom(`<h1>PRD: Keep live ownership</h1>
<section data-stage="01" data-title="Running" data-complexity="medium">
${assignment("worker-a", "running")}
<div data-acceptance="01.1" data-status="pending">The work completes.</div>
</section>`)

    const result = reconcilePlanAmendment(
      previous,
      `<h1>PRD: Keep live ownership</h1>
<section data-stage="02" data-title="Replacement">
<div data-acceptance="02.1" data-status="pending">Replacement works.</div>
</section>`
    )

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.diagnostics).toContainEqual({
      code: "running-stage-removed",
      message:
        'Running stage "01" cannot be removed. Stop its worker before removing the stage.'
    })
  })

  it("accepts a replacement route while retaining a compatible logical agent id", () => {
    const previous = documentFrom(`<h1>PRD: Reroute work</h1>
<section data-stage="01" data-title="Worker stage" data-complexity="medium">
${assignment("worker-a", "queued")}
<div data-acceptance="01.1" data-status="pending">The work completes.</div>
</section>`)
    const replacement = `<h1>PRD: Reroute work</h1>
<section data-stage="01" data-title="Worker stage" data-complexity="high">
<div data-assignment data-agent-id="replacement" data-cli="claude" data-model="opus" data-reason="Updated high-complexity route." data-status="queued"></div>
<div data-acceptance="01.1" data-status="pending">The work completes.</div>
</section>`

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.projection.stages[0]?.assignment).toMatchObject({
      agentId: "worker-a",
      cli: "claude",
      model: "opus"
    })
  })

  it("preserves prior user comments and unresolved worker annotations", () => {
    const previous = documentFrom(`<h1>PRD: Preserve notes</h1>
<section data-stage="01" data-title="Worker stage" data-complexity="medium">
${assignment("worker-a", "queued")}
<div data-acceptance="01.1" data-status="pending">The work completes.</div>
<aside data-annotation="user-note" data-stage="01" data-author="user" data-status="open">Keep the accessibility requirement.</aside>
<aside data-annotation="worker-note" data-stage="01" data-author="agent" data-status="open">Waiting for a fixture.</aside>
</section>`)
    const replacement = `<h1>PRD: Preserve notes</h1>
<section data-stage="01" data-title="Worker stage" data-complexity="medium">
${assignment("worker-a", "queued")}
<div data-acceptance="01.1" data-status="pending">The work completes.</div>
</section>`

    const result = reconcilePlanAmendment(previous, replacement)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.projection.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "user-note", author: "user", status: "open" }),
        expect.objectContaining({ id: "worker-note", author: "agent", status: "open" })
      ])
    )
  })
})

describe("planStageSemanticFingerprint", () => {
  it("ignores editor wrapper and mechanical metadata changes", () => {
    const previous = documentFrom(`<h1>PRD: Fingerprint</h1>
<section data-stage="01" data-title="Stable" data-complexity="medium">
${assignment("worker-a", "completed")}
<ol><li>Run tests</li></ol>
<div data-acceptance="01.1" data-status="passed" data-evidence="green">Tests pass.</div>
</section>`)
    const compact = previous.projection.stages[0]!
    const replacement = `<h1>PRD: Fingerprint</h1>
<section data-stage="01" data-title="Stable" data-complexity="medium">
${assignment("worker-b", "queued")}
<ol><li><p>Run tests</p></li></ol>
<div data-acceptance="01.1" data-status="pending">Tests pass.</div>
</section>`
    const replacementDocument = documentFrom(replacement)
    const roundTripped = replacementDocument.projection.stages[0]!

    expect(planStageSemanticFingerprint(roundTripped)).toBe(
      planStageSemanticFingerprint(compact)
    )
    const reconciled = reconcilePlanAmendment(previous, replacement)
    expect(reconciled.valid).toBe(true)
    if (!reconciled.valid) return
    expect(reconciled.changedStageIds).toEqual([])
    expect(reconciled.projection.stages[0]).toMatchObject({
      executionStatus: "completed",
      assignment: { agentId: "worker-a" },
      acceptance: [
        { id: "01.1", status: "passed", evidence: "green" }
      ]
    })
  })

  it("ignores agent-authored worker annotations", () => {
    const previous = documentFrom(`<h1>PRD: Fingerprint annotations</h1>
<section data-stage="01" data-title="Stable" data-complexity="medium">
${assignment("worker-a", "completed")}
<p>Implement the stable behavior.</p>
<div data-acceptance="01.1" data-status="passed" data-evidence="green">Tests pass.</div>
</section>`)
    const replacement = `<h1>PRD: Fingerprint annotations</h1>
<section data-stage="01" data-title="Stable" data-complexity="medium">
${assignment("worker-b", "queued")}
<p>Implement the stable behavior.</p>
<div data-acceptance="01.1" data-status="pending">Tests pass.</div>
<aside data-annotation="worker-note" data-stage="01" data-author="agent" data-status="open">Worker was interrupted.</aside>
</section>`

    const reconciled = reconcilePlanAmendment(previous, replacement)

    expect(reconciled.valid).toBe(true)
    if (!reconciled.valid) return
    expect(reconciled.changedStageIds).toEqual([])
    expect(reconciled.projection.stages[0]).toMatchObject({
      executionStatus: "completed",
      acceptance: [
        { id: "01.1", status: "passed", evidence: "green" }
      ]
    })
  })

  it("changes when semantic HTML attributes change", () => {
    const before = documentFrom(`<h1>PRD: Semantic attributes</h1>
<section data-stage="01" data-title="Stable" data-complexity="medium">
<ul data-files><li data-change="M">src/a.ts</li></ul>
<p><a href="https://example.com/old">Reference</a></p>
<div data-acceptance="01.1" data-status="pending">The change works.</div>
</section>`).projection.stages[0]!
    const after = documentFrom(`<h1>PRD: Semantic attributes</h1>
<section data-stage="01" data-title="Stable" data-complexity="medium">
<ul data-files><li data-change="D">src/a.ts</li></ul>
<p><a href="https://example.com/new">Reference</a></p>
<div data-acceptance="01.1" data-status="pending">The change works.</div>
</section>`).projection.stages[0]!

    expect(planStageSemanticFingerprint(after)).not.toBe(
      planStageSemanticFingerprint(before)
    )
  })
})

import { describe, expect, it } from "vitest"
import {
  appendPlanAnnotationHtml,
  appendPlanCommentMessageHtml,
  DEFAULT_PLAN_TEMPLATE_HTML,
  planLegacyCommentMessageId,
  parsePlanHtml,
  sanitizePlanHtml,
  updatePlanAnnotationStatusHtml,
  updatePlanCommentMessageDeliveryHtml,
  updatePlanCommentMentionDeliveriesHtml,
  updatePlanCriterionHtml
} from "./plan-html.js"

const DOC = `<h1>PRD: Ship it</h1>
<h2>Context</h2>
<p>One document is authoritative.</p>
<div data-diagram="mermaid"><pre>graph TD; A--&gt;B</pre></div>
<section data-stage="01" data-title="Persist the document" data-depends-on="" data-complexity="high">
<h3>Intent</h3>
<p>Keep every reader on one revision.</p>
<div data-assignment data-agent-id="worker-core" data-cli="codex" data-model="gpt-5" data-reason="Persistence needs careful reasoning." data-status="running"></div>
<div data-acceptance="01.1" data-status="pending">The source survives restart.</div>
<aside data-annotation="a1" data-stage="01" data-author="user" data-status="open" data-quote="revision">Which revision?</aside>
</section>
<h2>Risks</h2>
<ul><li>A risk.</li></ul>`

describe("parsePlanHtml", () => {
  it("extracts title, sections, stages, acceptance, and annotations", () => {
    const result = parsePlanHtml(DOC)
    expect(result.valid).toBe(true)
    const p = result.projection!
    expect(p.title).toBe("PRD: Ship it")
    expect(p.sections.map((s) => s.title)).toEqual(["Context", "Risks"])
    expect(p.stages).toHaveLength(1)
    expect(p.stages[0]!.title).toBe("Persist the document")
    expect(p.stages[0]!.intent).toContain("one revision")
    expect(p.stages[0]).toMatchObject({
      dependencies: [],
      complexity: "high",
      assignment: {
        agentId: "worker-core",
        cli: "codex",
        model: "gpt-5",
        reason: "Persistence needs careful reasoning."
      },
      executionStatus: "running"
    })
    expect(p.stages[0]?.assignment?.reasoning).toBeUndefined()
    expect(p.stages[0]!.acceptance[0]).toMatchObject({ id: "01.1", status: "pending" })
    expect(p.annotations[0]).toMatchObject({ id: "a1", stageId: "01" })
    expect(p.annotations[0]!.anchor?.quote).toBe("revision")
    expect(p.annotations[0]!.messages).toEqual([
      {
        id: planLegacyCommentMessageId("a1"),
        body: "Which revision?",
        authorKind: "user",
        authorId: "user",
        createdAt: "1970-01-01T00:00:00.000Z",
        mentionedParticipantIds: [],
        deliveryState: "sent"
      }
    ])
  })

  it("decodes legacy body-only annotations as stable one-message threads", () => {
    const source = DOC.replace(
      'data-status="open" data-quote="revision"',
      'data-status="resolved" data-created-at="2026-07-30T09:00:00.000Z" data-quote="revision" data-prefix="a " data-suffix=" value"'
    )
    const first = parsePlanHtml(source)
    const second = parsePlanHtml(first.html)

    expect(first.valid).toBe(true)
    expect(second.valid).toBe(true)
    if (!first.valid || !second.valid) return
    expect(second.projection.annotations[0]).toMatchObject({
      id: "a1",
      stageId: "01",
      author: "user",
      createdAt: "2026-07-30T09:00:00.000Z",
      status: "resolved",
      anchor: { quote: "revision", prefix: "a ", suffix: " value" },
      messages: [
        {
          id: "a1:message:1",
          body: "Which revision?",
          authorKind: "user",
          authorId: "user",
          createdAt: "2026-07-30T09:00:00.000Z",
          deliveryState: "sent"
        }
      ]
    })
  })

  it("parses ordered user and agent messages with mentions and delivery state", () => {
    const source = DOC.replace(
      "Which revision?",
      `<div data-comment-message="m-user" data-author-kind="user" data-author-id="operator-7" data-created-at="2026-07-30T10:00:00.000Z" data-mentioned-participant-ids="[&quot;worker-a&quot;]" data-delivery-state="sent">Please confirm.</div>
<div data-comment-message="m-agent" data-author-kind="agent" data-author-id="worker-a" data-created-at="2026-07-30T10:01:00.000Z" data-mentioned-participant-ids="[&quot;operator-7&quot;]" data-delivery-state="sent">Confirmed.</div>`
    )
    const result = parsePlanHtml(source)

    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.projection.annotations[0]?.messages).toEqual([
      expect.objectContaining({
        id: "m-user",
        authorKind: "user",
        authorId: "operator-7",
        mentionedParticipantIds: ["worker-a"],
        deliveryState: "sent"
      }),
      expect.objectContaining({
        id: "m-agent",
        authorKind: "agent",
        authorId: "worker-a",
        mentionedParticipantIds: ["operator-7"],
        deliveryState: "sent"
      })
    ])
  })

  it("defaults only open user messages with an actual mention to pending", () => {
    const source = DOC.replace(
      "Which revision?",
      `<div data-comment-message="plain" data-author-kind="user">Plain note.</div>
<div data-comment-message="targeted" data-author-kind="user" data-mentioned-participant-ids="[&quot;worker-a&quot;]">Targeted note.</div>`
    )
    const parsed = parsePlanHtml(source)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    expect(
      parsed.projection.annotations[0]?.messages.map((message) => message.deliveryState)
    ).toEqual(["sent", "pending"])
  })

  it("reports diagnostics for a doc with no title / no stage", () => {
    const result = parsePlanHtml("<p>just prose</p>")
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["missing-title", "missing-stage"])
    )
  })

  it("flags a stage with no acceptance and an invalid status", () => {
    const bad = `<h1>T</h1><section data-stage="01" data-title="x"><p>hi</p></section>`
    expect(parsePlanHtml(bad).diagnostics.some((d) => d.code === "missing-acceptance")).toBe(true)
    const badStatus = `<h1>T</h1><section data-stage="01" data-title="x"><div data-acceptance="1" data-status="nope">c</div></section>`
    expect(parsePlanHtml(badStatus).diagnostics.some((d) => d.code === "invalid-status")).toBe(true)
  })

  it("catches duplicate ids", () => {
    const dup = `<h1>T</h1><section data-stage="01" data-title="x"><div data-acceptance="01" data-status="pending">a</div></section><section data-stage="01" data-title="y"><div data-acceptance="z" data-status="pending">b</div></section>`
    expect(parsePlanHtml(dup).diagnostics.some((d) => d.code === "duplicate-id")).toBe(true)
  })

  it("validates the default template", () => {
    expect(parsePlanHtml(DEFAULT_PLAN_TEMPLATE_HTML).valid).toBe(true)
  })

  it.each([
    {
      name: "dangling dependency",
      stages: '<section data-stage="01" data-title="x" data-depends-on="02"><div data-acceptance="01.1" data-status="pending">a</div></section>',
      code: "dangling-dependency"
    },
    {
      name: "self dependency",
      stages: '<section data-stage="01" data-title="x" data-depends-on="01"><div data-acceptance="01.1" data-status="pending">a</div></section>',
      code: "self-dependency"
    },
    {
      name: "dependency cycle",
      stages: '<section data-stage="01" data-title="x" data-depends-on="02"><div data-acceptance="01.1" data-status="pending">a</div></section><section data-stage="02" data-title="y" data-depends-on="01"><div data-acceptance="02.1" data-status="pending">b</div></section>',
      code: "dependency-cycle"
    }
  ])("reports an actionable $name", ({ stages, code }) => {
    const result = parsePlanHtml(`<h1>T</h1>${stages}`)
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, message: expect.any(String) })])
    )
  })

  it("prevents approval when connected stages have incompatible worker routes", () => {
    const result = parsePlanHtml(`<h1>T</h1>
<section data-stage="01" data-title="x">
<div data-assignment data-agent-id="worker-a" data-cli="codex" data-model="gpt-5" data-reason="Core work." data-status="queued"></div>
<div data-acceptance="01.1" data-status="pending">a</div>
</section>
<section data-stage="02" data-title="y" data-depends-on="01">
<div data-assignment data-agent-id="worker-b" data-cli="claude" data-model="opus" data-reason="UI work." data-status="queued"></div>
<div data-acceptance="02.1" data-status="pending">b</div>
</section>`)
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "assignment-conflict" })])
    )
  })

  it("round-trips a provider-compatible reasoning setting", () => {
    const source = DOC.replace(
      'data-model="gpt-5"',
      'data-model="gpt-5" data-thinking-enabled="true" data-reasoning-effort="high"'
    )
    const first = parsePlanHtml(source)

    expect(first.valid).toBe(true)
    if (!first.valid) return
    expect(first.projection.stages[0]?.assignment?.reasoning).toStrictEqual({
      enabled: true,
      effort: "high"
    })
    expect(first.html).toContain('data-thinking-enabled="true"')
    expect(first.html).toContain('data-reasoning-effort="high"')

    const second = parsePlanHtml(first.html)
    expect(second.valid).toBe(true)
    if (!second.valid) return
    expect(second.projection.stages[0]?.assignment?.reasoning).toStrictEqual({
      enabled: true,
      effort: "high"
    })
  })

  it.each([
    ["a malformed toggle", 'data-thinking-enabled="sometimes"'],
    ["an effort without a toggle", 'data-reasoning-effort="high"'],
    ["a Claude-only effort on Codex", 'data-thinking-enabled="true" data-reasoning-effort="max"'],
    ["an effort while disabled", 'data-thinking-enabled="false" data-reasoning-effort="high"']
  ])("rejects %s", (_name, metadata) => {
    const result = parsePlanHtml(
      DOC.replace('data-model="gpt-5"', `data-model="gpt-5" ${metadata}`)
    )

    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-assignment" })
      ])
    )
  })

  it("can project structurally valid stages before worker-routing validation", () => {
    const source = `<h1>PRD: Route independent work</h1>
<section data-stage="05" data-title="Pricing" data-complexity="high">
<div data-assignment data-agent-id="worker-pricing" data-cli="codex" data-model="gpt-5" data-reason="Pricing work." data-status="queued"></div>
<ul data-files><li>src/pricing.ts</li></ul>
<div data-acceptance="05.1" data-status="pending">Pricing works.</div>
</section>
<section data-stage="06" data-title="Packaging" data-complexity="high">
<div data-assignment data-agent-id="worker-pricing" data-cli="codex" data-model="gpt-5" data-reason="Packaging work." data-status="queued"></div>
<ul data-files><li>src/packaging.ts</li></ul>
<div data-acceptance="06.1" data-status="pending">Packaging works.</div>
</section>`

    expect(parsePlanHtml(source).valid).toBe(false)
    const structural = parsePlanHtml(source, { validateExecutionGraph: false })
    expect(structural.valid).toBe(true)
    expect(structural.projection?.stages.map((stage) => stage.id)).toStrictEqual([
      "05",
      "06"
    ])
  })

  it("rejects malformed complexity, assignment, and execution state metadata", () => {
    const result = parsePlanHtml(`<h1>T</h1>
<section data-stage="01" data-title="x" data-complexity="enormous">
<div data-assignment data-agent-id="" data-cli="other" data-model="" data-reason="" data-status="sleeping"></div>
<div data-acceptance="01.1" data-status="pending">a</div>
</section>`)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "invalid-complexity",
        "invalid-assignment",
        "invalid-execution-status"
      ])
    )
  })
})

describe("sanitizePlanHtml", () => {
  it("strips script/style/iframe subtrees entirely", () => {
    const out = sanitizePlanHtml('<h1>T</h1><script>alert(1)</script><style>x{}</style><iframe src="x"></iframe><p>ok</p>')
    expect(out).not.toMatch(/script|style|iframe|alert/)
    expect(out).toContain("<p>ok</p>")
  })

  it("drops event handlers, inline styles, and javascript: hrefs but keeps content", () => {
    const out = sanitizePlanHtml('<p onclick="evil()" style="color:red">hi <a href="javascript:evil()">x</a></p>')
    expect(out).not.toMatch(/onclick|style=|javascript:/)
    expect(out).toContain("hi")
    expect(out).toContain(">x<")
  })

  it("unwraps disallowed tags but keeps their text", () => {
    const out = sanitizePlanHtml("<h1>T</h1><marquee><p>keep me</p></marquee>")
    expect(out).not.toMatch(/marquee/)
    expect(out).toContain("keep me")
  })

  it("preserves plan data-attributes", () => {
    const out = sanitizePlanHtml('<section data-stage="01" data-title="x" data-depends-on="00" data-complexity="high"><div data-assignment data-agent-id="worker-a" data-cli="codex" data-model="gpt-5" data-thinking-enabled="true" data-reasoning-effort="high" data-reason="Best fit" data-status="queued"></div><div data-acceptance="01.1" data-status="passed">c</div></section>')
    expect(out).toContain('data-stage="01"')
    expect(out).toContain('data-depends-on="00"')
    expect(out).toContain('data-complexity="high"')
    expect(out).toContain('data-agent-id="worker-a"')
    expect(out).toContain('data-cli="codex"')
    expect(out).toContain('data-thinking-enabled="true"')
    expect(out).toContain('data-reasoning-effort="high"')
    expect(out).toContain('data-status="passed"')
  })

  it("preserves only the safe nested comment-message attributes", () => {
    const out = sanitizePlanHtml(
      '<aside data-annotation="a1"><div data-comment-message="m1" data-author-kind="agent" data-author-id="worker-a" data-created-at="2026-07-31T00:00:00.000Z" data-mentioned-participant-ids="[&quot;operator&quot;]" data-delivery-state="sent" onclick="evil()">Safe reply.</div></aside>'
    )

    expect(out).toContain('data-comment-message="m1"')
    expect(out).toContain('data-author-id="worker-a"')
    expect(out).toContain('data-mentioned-participant-ids="[&quot;operator&quot;]"')
    expect(out).toContain('data-delivery-state="sent"')
    expect(out).not.toContain("onclick")
  })
})

describe("html source rewriters", () => {
  it("sets acceptance status + evidence in place", () => {
    const next = updatePlanCriterionHtml(DOC, "01.1", "passed", "unit test green")!
    const crit = parsePlanHtml(next).projection!.stages[0]!.acceptance[0]!
    expect(crit.status).toBe("passed")
    expect(crit.evidence).toBe("unit test green")
    expect(updatePlanCriterionHtml(DOC, "nope", "passed", null)).toBeNull()
  })

  it("appends an anchored annotation into its stage that parses back", () => {
    const next = appendPlanAnnotationHtml(DOC, {
      id: "c2",
      stageId: "01",
      body: 'tighten <this> & "that"',
      author: "user",
      createdAt: "2026-07-28T00:00:00.000Z",
      anchor: { quote: "survives", prefix: "source ", suffix: " restart" }
    })
    const ann = parsePlanHtml(next).projection!.annotations.find((a) => a.id === "c2")!
    expect(ann.stageId).toBe("01")
    expect(ann.body).toBe('tighten <this> & "that"')
    expect(ann.messages[0]).toMatchObject({
      id: "c2:message:1",
      body: 'tighten <this> & "that"',
      authorKind: "user",
      deliveryState: "sent"
    })
    expect(ann.anchor?.quote).toBe("survives")
  })

  it("appends messages, updates delivery, and resolves or reopens a thread", () => {
    const appended = appendPlanCommentMessageHtml(DOC, "a1", {
      id: "reply-1",
      body: "Revision 7 is current.",
      authorKind: "agent",
      authorId: "planner",
      createdAt: "2026-07-31T09:00:00.000Z",
      mentionedParticipantIds: ["operator"],
      deliveryState: "pending"
    })
    expect(appended).not.toBeNull()
    const sent = updatePlanCommentMessageDeliveryHtml(
      appended!,
      "a1",
      "reply-1",
      "sent"
    )
    const resolved = updatePlanAnnotationStatusHtml(sent!, "a1", "resolved")
    const reopened = updatePlanAnnotationStatusHtml(resolved!, "a1", "open")
    const parsed = parsePlanHtml(reopened!)

    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    const thread = parsed.projection.annotations[0]!
    expect(thread.status).toBe("open")
    expect(thread.messages.map((message) => message.id)).toEqual([
      "a1:message:1",
      "reply-1"
    ])
    expect(thread.messages[1]).toMatchObject({
      body: "Revision 7 is current.",
      authorKind: "agent",
      authorId: "planner",
      mentionedParticipantIds: ["operator"],
      deliveryState: "sent"
    })
  })

  it("round-trips per-target delivery details containing quotes", () => {
    const appended = appendPlanCommentMessageHtml(DOC, "a1", {
      id: "reply-outbox",
      body: "Coordinate this.",
      authorKind: "user",
      authorId: "operator",
      createdAt: "2026-07-31T09:00:00.000Z",
      mentionedParticipantIds: ["worker-a"],
      deliveryState: "pending"
    })!
    const updated = updatePlanCommentMentionDeliveriesHtml(
      appended,
      "a1",
      "reply-outbox",
      [
        {
          participantId: "worker-a",
          status: "unavailable",
          dispatchId: "reply-outbox:worker-a",
          detail: 'Participant "worker-a" stopped.',
          retryable: true
        }
      ],
      "failed"
    )!
    const parsed = parsePlanHtml(updated)
    expect(parsed.valid).toBe(true)
    if (!parsed.valid) return
    expect(parsed.projection.annotations[0]?.messages[1]).toMatchObject({
      deliveryState: "failed",
      mentionDeliveries: [
        {
          participantId: "worker-a",
          status: "unavailable",
          detail: 'Participant "worker-a" stopped.',
          retryable: true
        }
      ]
    })
  })
})

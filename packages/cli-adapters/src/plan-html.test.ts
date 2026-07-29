import { describe, expect, it } from "vitest"
import { planFromHtml, resolvePlanAnnotations } from "./plan-html.js"

describe("planFromHtml", () => {
  it("preserves stage approach and file linkage in the transcript projection", () => {
    const plan = planFromHtml(
      `<h1>PRD: File-aware plan</h1>
<section data-stage="s_01" data-title="Implement">
<h3>Intent</h3><p>Make the change.</p>
<h3>Approach</h3><ol><li>Trace the caller.</li><li>Update the store.</li></ol>
<ul data-files><li data-change="M" data-added="4" data-removed="1">src/store.ts</li></ul>
<div data-acceptance="s_01.1" data-status="pending">The store is updated.</div>
</section>`,
      "plan-1"
    )

    expect(plan?.steps[0]?.approach).toStrictEqual(["Trace the caller.", "Update the store."])
    expect(plan?.steps[0]?.files).toStrictEqual([
      { path: "src/store.ts", change: "M", added: 4, removed: 1 }
    ])
  })
})

describe("resolvePlanAnnotations", () => {
  it("resolves only the routed canonical aside regardless of attribute order", () => {
    const source = `<p>Keep this prose.</p>
<aside data-status="open" data-author="user" data-annotation="a1">First.</aside>
<aside data-annotation="a2" data-author="user">Second.</aside>
<div data-annotation="a1" data-status="open">Not a canonical annotation node.</div>`

    const resolved = resolvePlanAnnotations(source, new Set(["a2"]))

    // biome-ignore lint/security/noSecrets: canonical HTML fixture, not a credential
    expect(resolved).toContain(
      '<aside data-annotation="a2" data-author="user" data-status="resolved">Second.</aside>'
    )
    expect(resolved).toContain(
      '<aside data-status="open" data-author="user" data-annotation="a1">First.</aside>'
    )
    expect(resolved).toContain(
      '<div data-annotation="a1" data-status="open">Not a canonical annotation node.</div>'
    )
  })

  it("replaces an existing status without duplicating the attribute", () => {
    const source =
      '<aside data-annotation="a1" data-status="open" data-author="user">Comment.</aside>'

    expect(resolvePlanAnnotations(source, new Set(["a1"]))).toBe(
      '<aside data-annotation="a1" data-status="resolved" data-author="user">Comment.</aside>'
    )
  })
})

import { describe, expect, it } from "vitest"
import { withMultiRepoFooter, type RelatedPr } from "./pr-footer.js"

const web: RelatedPr = { repo: "web", number: 1, url: "https://x/web/1" }
const api: RelatedPr = { repo: "api", number: 2, url: "https://x/api/2" }
const lib: RelatedPr = { repo: "lib", number: 3, url: "https://x/lib/3" }

describe("withMultiRepoFooter", () => {
  it("adds no footer for a single PR and strips a stale one", () => {
    expect(withMultiRepoFooter("body", web, [web])).toBe("body")
    const stale = withMultiRepoFooter("body", web, [web, api])
    expect(withMultiRepoFooter(stale, web, [web])).toBe("body")
  })

  it("lists the other PRs under the N-repo heading", () => {
    const out = withMultiRepoFooter("body", web, [web, api, lib])
    expect(out).toContain("Part of an 3-repo change")
    expect(out).toContain("api#2 — https://x/api/2")
    expect(out).toContain("lib#3 — https://x/lib/3")
    expect(out).not.toContain("web#1")
  })

  it("is idempotent and refreshes when the set changes", () => {
    const once = withMultiRepoFooter("body", web, [web, api])
    expect(withMultiRepoFooter(once, web, [web, api])).toBe(once)
    const grown = withMultiRepoFooter(once, web, [web, api, lib])
    expect(grown.match(/<!-- jingler:multi-repo -->/gu)).toHaveLength(1)
    expect(grown).toContain("lib#3")
  })
})

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The renderer's CSP, asserted against the origins the app actually loads from.
 *
 * This exists because of a bug that shipped: the Connector Center derives
 * provider logos from `https://www.google.com/s2/favicons?domain=…`, that URL
 * answers **301** and redirects to `t{0..3}.gstatic.com`, and CSP is enforced
 * against the redirect TARGET. Allowing only `www.google.com` blocked every
 * logo. The component reports a blocked image as a load error and falls back to
 * an initial-letter tile, so nothing threw and nothing logged — the grid just
 * quietly showed letters.
 *
 * Storybook has no CSP, so component tests and visual review both passed. A
 * string check on the policy is the only cheap thing that would have caught it.
 */

const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8")

const directive = (name: string): string => {
  const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html)?.[1]
  expect(policy, "renderer index.html declares a CSP").toBeTruthy()
  const found = (policy ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `))
  return found ?? ""
}

describe("renderer CSP", () => {
  it("allows both origins the favicon service redirects across", () => {
    const imgSrc = directive("img-src")
    // The URL the component requests…
    expect(imgSrc).toContain("https://www.google.com")
    // …and where it lands. Missing this one silently degrades every logo.
    expect(imgSrc).toContain("https://*.gstatic.com")
  })

  it("still allows the GitHub asset origins markdown badges use", () => {
    const imgSrc = directive("img-src")
    expect(imgSrc).toContain("https://github.com")
    expect(imgSrc).toContain("https://*.githubusercontent.com")
  })

  it("keeps script and connect origins closed", () => {
    // Widening img-src is the only concession the logo feature needed; a future
    // edit that loosens script-src should have to delete this line first.
    expect(directive("script-src")).toBe("script-src 'self'")
    expect(directive("default-src")).toBe("default-src 'self'")
  })
})

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

  it("keeps script-src to 'self' plus the local plugin scheme, and nothing else", () => {
    // Plugin UI is ES modules the renderer imports, so `script-src` had to give
    // exactly one inch: the `jingler-plugin:` scheme, which the main process
    // serves ONLY from `~/jingler/plugins`. Pinned as an exact string so that
    // widening it to a remote origin — the one thing an agent harness must
    // never do — cannot happen without deleting this assertion first.
    expect(directive("script-src")).toBe("script-src 'self' jingler-plugin:")
    expect(directive("default-src")).toBe("default-src 'self'")
  })

  it("does NOT widen connect-src for plugins", () => {
    // A plugin's renderer half can be loaded from disk but must not be able to
    // phone home. Outbound traffic belongs in the extension host, where the
    // operator's consent for a provider and its scopes is recorded and
    // revocable. `connect-src` is absent, so it inherits `default-src 'self'`.
    expect(directive("connect-src")).toBe("")
    expect(directive("default-src")).toBe("default-src 'self'")
  })

  it("maps every bare specifier a plugin may import to the runtime shim host", () => {
    // Two copies of React in one tree makes every hook throw "invalid hook
    // call", and the failure only shows up once a SECOND plugin is installed.
    // The importmap is what prevents it, so its absence should fail loudly here
    // rather than quietly in a user's app.
    const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1]
    expect(importmap, "renderer index.html declares an importmap").toBeTruthy()
    const { imports } = JSON.parse(importmap ?? "{}") as {
      imports: Record<string, string>
    }
    for (const specifier of [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@jingler/plugin-sdk"
    ]) {
      expect(imports[specifier], `${specifier} is mapped`).toMatch(
        /^jingler-plugin:\/\/runtime\//
      )
    }
  })
})

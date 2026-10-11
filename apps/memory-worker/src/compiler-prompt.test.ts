import { describe, expect, it } from "vitest"
import type { MemoryPage, MemorySource } from "@jingler/memory"
import { buildCompilerPrompt } from "./compiler-prompt.js"

const source: MemorySource = {
  id: "source-redacted",
  kind: "conversation",
  title: "Settled session"
}

const accepted: MemoryPage = {
  id: "refund-operations",
  path: "refund-operations.md",
  title: "Refund operations",
  revision: 3,
  aliases: ["Refund retries"],
  tags: ["refunds"],
  sources: [],
  citations: [],
  relationships: [],
  body: `# Refund operations\n\n${"bounded ".repeat(2_000)}tail-must-not-escape`,
  metadata: { citationPolicy: "none" }
}

const prompt = (): string =>
  buildCompilerPrompt({
    source,
    claims: [
      {
        claim: "Refund retries share one limiter because the provider cap is global.",
        start: 10,
        end: 76,
        quote: "Refund retries share one limiter because the provider cap is global."
      }
    ],
    createTarget: {
      action: "create",
      pageId: "learning-redacted",
      path: "learnings/refund-retries-redacted.md",
      title: "Refund retries share one limiter"
    },
    schemaPages: [],
    candidatePages: [{ page: accepted, revisionId: "refund-operations-r3" }],
    indexMarkdown: "# Index"
  })

describe("compiler prompt", () => {
  it("requires structured bounded candidates rather than model-authored Markdown", () => {
    const value = prompt()

    // biome-ignore lint/security/noSecrets: this is a schema name, not a credential.
    expect(value).toContain("MemoryCompilerCandidateResult")
    expect(value).toContain("at most three standalone durable memory candidates")
    expect(value).toContain("Do not emit Markdown")
    expect(value).toContain("refund-operations-r3")
    expect(value).toContain("learning-redacted")
  })

  it("labels page prose as untrusted and bounds the accepted body", () => {
    const value = prompt()

    expect(value).toContain("untrusted evidence")
    expect(value).toContain("source-redacted")
    expect(value).not.toContain("tail-must-not-escape")
  })
})

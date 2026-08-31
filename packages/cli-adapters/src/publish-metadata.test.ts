import { describe, expect, it } from "vitest"
import type { Message, Session } from "@jingler/core"
import { ProviderConnectionId, ProviderModelId } from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import {
  fallbackPublishMetadata,
  makeAgentRuntimePublishMetadataGenerator,
  parsePublishMetadata,
  type PublishMetadataInput
} from "./publish-metadata.js"

const input: PublishMetadataInput = {
  session: {
    id: "session-1", repo: "jingler/jingler", branch: "feat/secure-publish",
    semanticBranchProposal: { type: "feat", slug: "secure-publish" },
    title: "Secure deterministic publishing", status: "idle",
    diff: { added: 10, removed: 2 }, prNumber: null, costUsd: 0, tokens: 0,
    updatedAt: new Date().toISOString(), chats: [], activeChatId: "chat-1"
  } as Session,
  messages: [] as Message[],
  changedPaths: ["src/publish.ts"],
  diffSummary: "1 file changed"
}

describe("publish metadata", () => {
  it("generates metadata through the session's canonical pi connection", async () => {
    let role: string | undefined
    const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("connection-1")
    const modelId = Schema.decodeUnknownSync(ProviderModelId)("openai/gpt-5")
    const generator = makeAgentRuntimePublishMetadataGenerator({
      run: (spec) => {
        role = spec.role
        return Stream.succeed({
          _tag: "Assistant",
          text: JSON.stringify({
            commitMessage: "feat: route publishing through pi",
            prTitle: "Route publishing through pi",
            prBody: "## Summary\n\nUses the canonical runtime."
          })
        })
      },
      steer: () => Effect.void,
      interrupt: () => Effect.void,
      controlSubagent: () => Effect.die("unused"),
      decidePlanReview: () => Effect.die("unused"),
      subagentFleetSnapshot: () => Effect.die("unused"),
      subagentTranscript: () => Effect.die("unused")
    })
    const metadata = await Effect.runPromise(generator.generate({
      ...input,
      session: {
        ...input.session,
        chats: [{
          id: "chat-1",
          title: null,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
          connectionId,
          modelId
        }]
      }
    }))

    expect(role).toBe("background")
    expect(metadata.commitMessage).toBe("feat: route publishing through pi")
  })

  it("accepts bounded Conventional Commit metadata", () => {
    expect(parsePublishMetadata(JSON.stringify({
      commitMessage: "feat(publish): add secure PR workflow",
      prTitle: "Add secure PR workflow",
      prBody: "## Summary\n\nAdds secure publishing."
    }), input).commitMessage).toBe("feat(publish): add secure PR workflow")
  })

  it.each([
    "feat: valid\n--author attacker",
    "not-conventional",
    `feat: ${"x".repeat(67)}`,
    "feat: $(touch publish-owned)",
    "feat: safe && git push attacker main"
  ])("falls back for unsafe commit subjects: %s", (commitMessage) => {
    expect(parsePublishMetadata(JSON.stringify({ commitMessage, prTitle: "Unsafe", prBody: "body" }), input))
      .toEqual(fallbackPublishMetadata(input))
  })

  it("uses the semantic branch type in deterministic fallback", () => {
    expect(parsePublishMetadata("not json", input)).toMatchObject({
      commitMessage: "feat: secure publish"
    })
  })

  it("rejects credential-shaped PR prose without retaining the credential", () => {
    const credential = `sk-${"a".repeat(20)}`
    const parsed = parsePublishMetadata(JSON.stringify({
      commitMessage: "feat: secure publish metadata",
      prTitle: "Secure publish metadata",
      prBody: `## Summary\n\nToken: ${credential}`
    }), input)

    expect(parsed).toEqual(fallbackPublishMetadata(input))
    expect(JSON.stringify(parsed)).not.toContain(credential)
  })

  it("sanitizes unsafe fallback titles and changed paths", () => {
    const hostile = {
      ...input,
      session: { ...input.session, title: "$(touch title-owned)" },
      changedPaths: ["src/safe.ts", "`touch path-owned`"]
    }
    const fallback = fallbackPublishMetadata(hostile)

    expect(fallback.prTitle).toBe("Publish secure publish")
    expect(fallback.prBody).toContain("src/safe.ts")
    expect(fallback.prBody).not.toContain("path-owned")
  })
})

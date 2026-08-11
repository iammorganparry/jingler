import {
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  migrateLegacyConfigIdentity,
  migrateLegacyRuntimeIdentity
} from "./legacy-runtime-identity.js"

const resolved = {
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("connection-1"),
  providerId: Schema.decodeUnknownSync(ProviderId)("anthropic"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet")
}

describe("legacy runtime identity migration", () => {
  it.each([
    ["claude", "sonnet", "anthropic"],
    ["codex", "gpt-5", "openai-codex"],
    ["opencode", "openrouter/model", "openrouter"]
  ])("infers %s provider while requiring explicit connection recovery", (cli, model, providerId) => {
    const result = migrateLegacyRuntimeIdentity({
      id: "session-1",
      cli,
      activeChatId: "chat-1",
      chats: [{ id: "chat-1", model, resumeId: "native-thread" }],
      transcriptMarker: "preserved"
    }) as Record<string, unknown>
    expect(result).toMatchObject({
      providerId,
      connectionSelectionRequired: true,
      modelSelectionRequired: true,
      legacyModel: model,
      legacyResumeId: "native-thread",
      transcriptMarker: "preserved"
    })
    expect(result).not.toHaveProperty("resumeId", "native-thread")
    expect(result).not.toHaveProperty("cli")
    expect(result.chats).toEqual([
      expect.objectContaining({
        id: "chat-1",
        legacyModel: model,
        legacyResumeId: "native-thread",
        connectionSelectionRequired: true,
        modelSelectionRequired: true
      })
    ])
    expect((result.chats as Array<Record<string, unknown>>)[0]).not.toHaveProperty("resumeId")
  })

  it("does not guess Cursor or an unqualified opencode model", () => {
    for (const [cli, model] of [["cursor", "cursor-small"], ["opencode", "model"]]) {
      expect(migrateLegacyRuntimeIdentity({ cli, chats: [] })).toMatchObject({
        connectionSelectionRequired: true,
        modelSelectionRequired: true
      })
    }
  })

  it("accepts only an exact externally certified resolution", () => {
    const result = migrateLegacyRuntimeIdentity(
      {
        cli: "claude",
        activeChatId: "chat-1",
        chats: [{ id: "chat-1", model: "claude-sonnet" }]
      },
      (candidate) => candidate.model === "claude-sonnet" ? resolved : null
    ) as Record<string, unknown>
    expect(result).toMatchObject({
      connectionId: "connection-1",
      providerId: "anthropic",
      modelId: "anthropic/claude-sonnet",
      connectionSelectionRequired: false,
      modelSelectionRequired: false
    })
  })

  it("migrates config defaults without inventing a credential connection", () => {
    expect(migrateLegacyConfigIdentity({
      defaultCli: "claude",
      providers: { claude: { defaultModel: "sonnet" } },
      reposDir: "/repos"
    })).toMatchObject({
      defaultProviderId: "anthropic",
      connectionSelectionRequired: true,
      reposDir: "/repos"
    })
  })
})

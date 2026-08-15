import type { Chat, ProviderCatalog, Session } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  adoptableChatIdentities,
  sessionNeedsRuntimeIdentity
} from "./adopt-runtime-identity.js"

const chat = (over: Partial<Chat>): Chat =>
  ({
    id: "chat-1",
    title: "Chat",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over
  }) as Chat

const session = (over: Partial<Session>, chats: ReadonlyArray<Chat>): Session =>
  ({
    id: "session-1",
    activeChatId: chats[0]?.id ?? "chat-1",
    chats,
    ...over
  }) as Session

const catalogModel = (providerId: string, id: string, selectable = true) => ({
  providerId,
  id,
  label: id,
  capabilities: { contextWindow: null, reasoning: [], vision: false },
  verification: "unverified",
  selectable,
  certificationKey: null
})

const catalog = {
  connections: [
    {
      connection: {
        id: "anthropic-1",
        providerId: "anthropic",
        authKind: "claude-setup-token",
        status: "authenticated"
      },
      models: [
        catalogModel("anthropic", "anthropic/claude-fable-5"),
        catalogModel("anthropic", "anthropic/claude-sonnet-5")
      ]
    },
    {
      connection: {
        id: "codex-1",
        providerId: "openai-codex",
        authKind: "openai-codex-oauth",
        status: "authenticated"
      },
      models: [catalogModel("openai-codex", "openai-codex/gpt-5.6-sol")]
    }
  ],
  refreshedAt: "2026-08-14T00:00:00.000Z",
  stale: false
} as unknown as ProviderCatalog

describe("adoptableChatIdentities", () => {
  it("adopts the same provider's connection and honors the legacy model", () => {
    const gated = chat({
      connectionSelectionRequired: true,
      modelSelectionRequired: true,
      providerId: "anthropic" as Chat["providerId"],
      legacyModel: "claude-sonnet-5"
    })
    const s = session({}, [gated])
    expect(sessionNeedsRuntimeIdentity(s)).toBe(true)
    expect(adoptableChatIdentities(s, catalog, {})).toEqual([
      {
        chatId: "chat-1",
        connectionId: "anthropic-1",
        providerId: "anthropic",
        modelId: "anthropic/claude-sonnet-5"
      }
    ])
  })

  it("falls back to the configured default connection when the provider is unknown", () => {
    const gated = chat({ connectionSelectionRequired: true })
    const s = session({}, [gated])
    const adopted = adoptableChatIdentities(s, catalog, {
      connectionId: "codex-1" as never,
      modelId: "openai-codex/gpt-5.6-sol" as never
    })
    expect(adopted).toEqual([
      {
        chatId: "chat-1",
        connectionId: "codex-1",
        providerId: "openai-codex",
        modelId: "openai-codex/gpt-5.6-sol"
      }
    ])
  })

  it("re-affirms a healthy active chat to clear session-level flags", () => {
    const healthy = chat({
      connectionId: "anthropic-1" as Chat["connectionId"],
      providerId: "anthropic" as Chat["providerId"],
      modelId: "anthropic/claude-fable-5" as Chat["modelId"]
    })
    const s = session({ connectionSelectionRequired: true }, [healthy])
    expect(sessionNeedsRuntimeIdentity(s)).toBe(true)
    expect(adoptableChatIdentities(s, catalog, {})).toEqual([
      {
        chatId: "chat-1",
        connectionId: "anthropic-1",
        providerId: "anthropic",
        modelId: "anthropic/claude-fable-5"
      }
    ])
  })

  it("leaves fresh chats and unsatisfiable sessions alone", () => {
    const fresh = chat({})
    expect(sessionNeedsRuntimeIdentity(session({}, [fresh]))).toBe(false)

    const gated = chat({ connectionSelectionRequired: true })
    const empty = { connections: [], refreshedAt: null, stale: false } as unknown as ProviderCatalog
    expect(adoptableChatIdentities(session({}, [gated]), empty, {})).toEqual([])
  })
})

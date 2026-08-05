import { describe, expect, it } from "vitest"
import {
  claimGitHubDelivery,
  encodeGitHubRelayClientMessage,
  findGitHubFeedbackTarget,
  githubFeedbackInstruction,
  parseGitHubRelayServerMessage,
  type GitHubRelayEvent
} from "./github-events.js"

const event = (patch: Partial<GitHubRelayEvent> = {}): GitHubRelayEvent => ({
  version: 1,
  deliveryId: "delivery-1",
  semanticKey: "semantic-1",
  event: "pull_request_review_comment",
  action: "created",
  installationId: "99",
  repository: { id: "200", owner: "acme", name: "widget", fullName: "acme/widget" },
  pullRequest: {
    id: "300",
    number: 42,
    title: "Improve routing",
    url: "https://github.com/acme/widget/pull/42",
    headSha: "head",
    baseSha: "base"
  },
  actor: { id: "400", login: "reviewer", type: "User" },
  feedback: {
    kind: "review-comment",
    id: "500",
    body: "Please handle the reconnect race.",
    state: null,
    path: "src/relay.ts",
    line: 27,
    side: "RIGHT"
  },
  actionable: true,
  occurredAt: "2026-08-05T09:00:00.000Z",
  ...patch
})

describe("GitHub relay protocol", () => {
  it("decodes only complete versioned server envelopes", () => {
    expect(
      parseGitHubRelayServerMessage(JSON.stringify({ type: "event", cursor: 8, event: event() }))
    ).toEqual({ type: "event", cursor: 8, event: event() })
    expect(parseGitHubRelayServerMessage('{"type":"event","cursor":-1}')).toBeNull()
    expect(
      parseGitHubRelayServerMessage({ type: "event", cursor: 1, event: { ...event(), version: 2 } })
    ).toBeNull()
    expect(parseGitHubRelayServerMessage("not-json")).toBeNull()
  })

  it("encodes cursor acknowledgement, replay, and heartbeat messages", () => {
    expect(encodeGitHubRelayClientMessage({ type: "ack", cursor: 7 })).toBe(
      '{"type":"ack","cursor":7}'
    )
    expect(encodeGitHubRelayClientMessage({ type: "resume", cursor: 7 })).toBe(
      '{"type":"resume","cursor":7}'
    )
    expect(encodeGitHubRelayClientMessage({ type: "ping" })).toBe('{"type":"ping"}')
  })
})

describe("GitHub feedback routing primitives", () => {
  it("requires an exact active installation, repository id, and PR match", () => {
    const target = {
      sessionId: "session-1",
      chatId: "chat-1",
      installationId: "99",
      repositoryId: "200",
      prNumber: 42,
      archived: false
    }
    expect(findGitHubFeedbackTarget(event(), [target])).toEqual(target)
    expect(findGitHubFeedbackTarget(event({ installationId: "100" }), [target])).toBeNull()
    expect(findGitHubFeedbackTarget(event({ repository: { ...event().repository, id: "201" } }), [target])).toBeNull()
    expect(findGitHubFeedbackTarget(event(), [{ ...target, archived: true }])).toBeNull()
  })

  it("deduplicates both GitHub deliveries and semantically unchanged edits with bounded state", () => {
    const empty = { deliveryIds: [], semanticKeys: [] }
    const first = claimGitHubDelivery(empty, event(), 2)
    expect(first.duplicate).toBe(false)
    expect(claimGitHubDelivery(first.ledger, event(), 2).duplicate).toBe(true)
    expect(
      claimGitHubDelivery(first.ledger, event({ deliveryId: "delivery-2" }), 2).duplicate
    ).toBe(true)
    const second = claimGitHubDelivery(
      first.ledger,
      event({ deliveryId: "delivery-2", semanticKey: "semantic-2" }),
      2
    )
    const third = claimGitHubDelivery(
      second.ledger,
      event({ deliveryId: "delivery-3", semanticKey: "semantic-3" }),
      2
    )
    expect(third.ledger.deliveryIds).toEqual(["delivery-2", "delivery-3"])
  })

  it("formats bounded visible instructions with code location context", () => {
    expect(githubFeedbackInstruction(event())).toContain(
      "GitHub feedback from @reviewer on acme/widget#42.\nLocation: src/relay.ts:27 (RIGHT)"
    )
    expect(githubFeedbackInstruction(event())).toContain("Please handle the reconnect race.")
    expect(githubFeedbackInstruction(event({ actionable: false }))).toBeNull()
  })
})

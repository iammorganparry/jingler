import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  issueOffloadGrant,
  verifyOffloadGrant,
  type VerifyOffloadGrantExpected
} from "./offload-grant.js"

const SIGNING_SECRET = "offload-test-signing-key-with-at-least-32-bytes"
const issuedAt = 1_900_000_000
const input = {
  subject: "user_one",
  sessionId: "session_aaaaaaaaaaaaaaaa",
  jobId: "job_aaaaaaaaaaaaaaaa",
  idempotencyKey: "request_aaaaaaaaaaaaaaaa",
  repositorySlug: "jingler/example",
  snapshotDigest: "a".repeat(64),
  actions: ["snapshot.upload", "job.run", "job.read", "job.cancel"]
} as const
const expected: VerifyOffloadGrantExpected = {
  action: "snapshot.upload",
  subject: input.subject,
  sessionId: input.sessionId,
  jobId: input.jobId,
  repositorySlug: input.repositorySlug,
  snapshotDigest: input.snapshotDigest
}

const issue = () =>
  Effect.runPromise(
    issueOffloadGrant(
      input,
      SIGNING_SECRET,
      issuedAt,
      "grant_aaaaaaaaaaaaaaaa"
    )
  )

describe("offload grant scope", () => {
  it("verifies an exact unconsumed action scope", async () => {
    const issued = await issue()
    await expect(
      Effect.runPromise(
        verifyOffloadGrant(issued.grant, SIGNING_SECRET, expected, issuedAt + 1)
      )
    ).resolves.toEqual({ ok: true, claims: issued.claims })
  })

  it.each([
    ["subject", { subject: "user_two" }],
    ["session", { sessionId: "session_bbbbbbbbbbbbbbbb" }],
    ["job", { jobId: "job_bbbbbbbbbbbbbbbb" }],
    ["repository", { repositorySlug: "other/example" }],
    ["digest", { snapshotDigest: "b".repeat(64) }]
  ] as const)("denies a cross-%s grant", async (_label, override) => {
    const issued = await issue()
    const verified = await Effect.runPromise(
      verifyOffloadGrant(
        issued.grant,
        SIGNING_SECRET,
        { ...expected, ...override },
        issuedAt + 1
      )
    )
    expect(verified).toEqual({ ok: false, reason: "wrong-scope" })
  })

  it("denies an action outside the grant", async () => {
    const issued = await Effect.runPromise(
      issueOffloadGrant(
        { ...input, actions: ["job.read"] },
        SIGNING_SECRET,
        issuedAt,
        "grant_aaaaaaaaaaaaaaaa"
      )
    )
    await expect(
      Effect.runPromise(
        verifyOffloadGrant(issued.grant, SIGNING_SECRET, expected, issuedAt + 1)
      )
    ).resolves.toEqual({ ok: false, reason: "action-denied" })
  })
})

describe("offload grant lifetime", () => {
  it("denies expired and replayed grants", async () => {
    const issued = await issue()
    await expect(
      Effect.runPromise(
        verifyOffloadGrant(issued.grant, SIGNING_SECRET, expected, issued.claims.expiresAt)
      )
    ).resolves.toEqual({ ok: false, reason: "expired" })
    await expect(
      Effect.runPromise(
        verifyOffloadGrant(
          issued.grant,
          SIGNING_SECRET,
          {
            ...expected,
            consumedGrantIds: new Set([issued.claims.grantId])
          },
          issuedAt + 1
        )
      )
    ).resolves.toEqual({ ok: false, reason: "replayed" })
  })

  it("denies malformed and tampered grants", async () => {
    const issued = await issue()
    await expect(
      Effect.runPromise(
        verifyOffloadGrant(`${issued.grant}x`, SIGNING_SECRET, expected, issuedAt + 1)
      )
    ).resolves.toEqual({ ok: false, reason: "invalid-signature" })
    await expect(
      Effect.runPromise(
        verifyOffloadGrant("invalid", SIGNING_SECRET, expected, issuedAt + 1)
      )
    ).resolves.toEqual({ ok: false, reason: "malformed" })
  })
})

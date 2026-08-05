import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { Database } from "../database.js"
import { GitHubConnectionRepository } from "./github-connection-repository.js"

const authorizationRow = {
  id: "authorization-1",
  userId: "user-1",
  githubUserId: "7",
  githubLogin: "octocat",
  githubName: "Octo Cat",
  githubAvatarUrl: null,
  accessTokenEncrypted: "v1.encrypted-access",
  refreshTokenEncrypted: "v1.encrypted-refresh",
  accessTokenExpiresAt: new Date("2026-08-04T18:00:00Z"),
  refreshTokenExpiresAt: new Date("2027-02-04T10:00:00Z"),
  createdAt: new Date("2026-08-04T10:00:00Z"),
  updatedAt: new Date("2026-08-04T10:00:00Z"),
  lastRefreshedAt: new Date("2026-08-04T10:00:00Z")
}

const installationRow = {
  id: "row-1",
  authorizationId: "authorization-1",
  installationId: "99",
  accountId: "8",
  accountLogin: "acme",
  accountType: "Organization",
  accountAvatarUrl: null,
  repositorySelection: "selected",
  permissions: '{"contents":"read","pull_requests":"write"}',
  suspendedAt: null,
  createdAt: new Date("2026-08-04T10:00:00Z"),
  updatedAt: new Date("2026-08-04T10:00:00Z")
}

const callbackRow = {
  id: "state-1",
  stateHash: "sha256-state",
  userId: "user-1",
  kind: "install",
  redirectUri: "jingler://auth/callback",
  codeVerifierEncrypted: "v1.encrypted-verifier",
  expiresAt: new Date("2026-08-04T10:10:00Z"),
  consumedAt: new Date("2026-08-04T10:01:00Z"),
  createdAt: new Date("2026-08-04T10:00:00Z")
}

const relayMutationRow = {
  id: "relay-mutation-1",
  userId: "user-1",
  installationId: "99",
  desiredState: "removed",
  generation: 3,
  attemptCount: 2,
  nextAttemptAt: new Date("2026-08-04T10:02:00Z"),
  deliveredAt: null,
  lastError: "Error",
  createdAt: new Date("2026-08-04T10:00:00Z"),
  updatedAt: new Date("2026-08-04T10:01:00Z")
}

const runWith = <A>(
  results: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<A, unknown, GitHubConnectionRepository>
): Promise<A> => {
  const database = Layer.succeed(Database, {
    run: (operation: string) => Effect.succeed(results[operation])
  } as unknown as Database)
  return Effect.runPromise(
    effect.pipe(Effect.provide(GitHubConnectionRepository.Default), Effect.provide(database))
  )
}

describe("GitHubConnectionRepository", () => {
  it("maps encrypted authorization state without touching BetterAuth accounts", async () => {
    const authorization = Option.getOrNull(
      await runWith(
        {
          "GitHubConnectionRepository.findAuthorizationByUserId": [authorizationRow]
        },
        GitHubConnectionRepository.findAuthorizationByUserId("user-1")
      )
    )
    expect(authorization).toMatchObject({
      userId: "user-1",
      githubLogin: "octocat",
      accessTokenEncrypted: "v1.encrypted-access"
    })
    expect(JSON.stringify(authorization)).not.toContain("installationAccessToken")
  })

  it("maps installation ownership and extensible permission metadata", async () => {
    const installations = await runWith(
      {
        "GitHubConnectionRepository.listInstallationsByAuthorizationId": [installationRow]
      },
      GitHubConnectionRepository.listInstallationsByAuthorizationId("authorization-1")
    )
    expect(installations).toEqual([
      expect.objectContaining({
        authorizationId: "authorization-1",
        installationId: "99",
        repositorySelection: "selected",
        permissions: { contents: "read", pull_requests: "write" }
      })
    ])
    expect(JSON.stringify(installations)).not.toMatch(/ghs_|accessToken/i)
  })

  it("returns None when the atomic replay-lock update matches no callback state", async () => {
    const rejected = await runWith(
      { "GitHubConnectionRepository.consumeCallbackState": [] },
      GitHubConnectionRepository.consumeCallbackState({
        stateHash: "wrong-or-used",
        userId: "user-1",
        kinds: ["install"],
        at: new Date("2026-08-04T10:01:00Z")
      })
    )
    expect(Option.isNone(rejected)).toBe(true)

    const consumed = await runWith(
      { "GitHubConnectionRepository.consumeCallbackState": [callbackRow] },
      GitHubConnectionRepository.consumeCallbackState({
        stateHash: "sha256-state",
        userId: "user-1",
        kinds: ["install"],
        at: new Date("2026-08-04T10:01:00Z")
      })
    )
    expect(Option.getOrNull(consumed)).toMatchObject({
      kind: "install",
      userId: "user-1"
    })
  })

  it("maps retryable relay mutations without installation credentials or payload bodies", async () => {
    const mutations = await runWith(
      {
        "GitHubConnectionRepository.listPendingRelayMutations": [relayMutationRow]
      },
      GitHubConnectionRepository.listPendingRelayMutations(new Date("2026-08-04T10:03:00Z"))
    )
    expect(mutations).toEqual([
      {
        id: "relay-mutation-1",
        userId: "user-1",
        installationId: "99",
        desiredState: "removed",
        generation: 3,
        attemptCount: 2
      }
    ])
    expect(JSON.stringify(mutations)).not.toMatch(/token|body|credential/i)
  })
})

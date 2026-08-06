import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { Database } from "../database.js"
import { GitHubSessionRouteRepository } from "./github-session-route-repository.js"

const routeRow = {
  id: "route-1",
  userId: "user-1",
  sessionId: "local-session-1",
  relaySessionId: "opaque_session_identifier_123",
  installationId: "99",
  repositoryId: "301",
  pullRequestNumber: 42,
  state: "active",
  generation: 4,
  archivedAt: null,
  unlinkedAt: null,
  createdAt: new Date("2026-08-05T12:00:00Z"),
  updatedAt: new Date("2026-08-05T12:00:00Z")
}

const mutationRow = {
  id: "mutation-1",
  userId: "user-1",
  relaySessionId: "opaque_session_identifier_123",
  installationId: "99",
  repositoryId: "301",
  pullRequestNumber: 42,
  desiredState: "archived",
  generation: 5,
  attemptCount: 2,
  nextAttemptAt: new Date("2026-08-05T12:03:00Z"),
  deliveredAt: null,
  lastError: "RelayUnavailable",
  createdAt: new Date("2026-08-05T12:00:00Z"),
  updatedAt: new Date("2026-08-05T12:02:00Z")
}

const runWith = <A>(
  results: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<A, unknown, GitHubSessionRouteRepository>
): Promise<A> => {
  const database = Layer.succeed(Database, {
    run: (operation: string) => Effect.succeed(results[operation])
  } as unknown as Database)
  return Effect.runPromise(
    effect.pipe(Effect.provide(GitHubSessionRouteRepository.Default), Effect.provide(database))
  )
}

describe("GitHubSessionRouteRepository", () => {
  it("maps only routes owned by the authenticated user", async () => {
    const routes = await runWith(
      { "GitHubSessionRouteRepository.listByUserId": [routeRow] },
      GitHubSessionRouteRepository.listByUserId("user-1")
    )
    expect(routes).toEqual([expect.objectContaining(routeRow)])
    expect(JSON.stringify(routes)).not.toMatch(/token|secret|credential/i)
  })

  it("returns no route when the user and opaque relay session do not match", async () => {
    const missing = await runWith(
      { "GitHubSessionRouteRepository.findForUser": [] },
      GitHubSessionRouteRepository.findForUser("user-2", "opaque_session_identifier_123")
    )
    expect(Option.isNone(missing)).toBe(true)
  })

  it("maps retryable Workflow mutations without exposing the local session id", async () => {
    const mutations = await runWith(
      { "GitHubSessionRouteRepository.listPendingMutations": [mutationRow] },
      GitHubSessionRouteRepository.listPendingMutations(new Date("2026-08-05T12:04:00Z"))
    )
    expect(mutations).toEqual([
      {
        id: "mutation-1",
        userId: "user-1",
        relaySessionId: "opaque_session_identifier_123",
        installationId: "99",
        repositoryId: "301",
        pullRequestNumber: 42,
        desiredState: "archived",
        generation: 5,
        attemptCount: 2
      }
    ])
    expect(JSON.stringify(mutations)).not.toContain("local-session-1")
  })
})

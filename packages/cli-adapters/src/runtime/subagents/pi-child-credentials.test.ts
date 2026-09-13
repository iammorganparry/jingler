import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ProviderConnection,
  ProviderConnectionId
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import {
  childProviderConnections,
  PiChildCredentials
} from "./pi-child-credentials.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
)

const connection = Schema.decodeUnknownSync(ProviderConnection)({
  id: "anthropic-api",
  providerId: "anthropic",
  authKind: "api-key",
  account: null,
  targetId: "desktop",
  status: "authenticated",
  subscription: {
    entitlement: "active",
    planLabel: null,
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute: "api"
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
})

const alternateAnthropicConnection = Schema.decodeUnknownSync(ProviderConnection)({
  ...connection,
  id: "anthropic-alternate"
})

const codexConnection = Schema.decodeUnknownSync(ProviderConnection)({
  ...connection,
  id: "codex-oauth",
  providerId: "openai-codex",
  authKind: "openai-codex-oauth"
})

const claudeCliConnection = Schema.decodeUnknownSync(ProviderConnection)({
  ...connection,
  id: "claude-cli",
  authKind: "claude-setup-token",
  subscription: {
    ...connection.subscription,
    confirmedBillingRoute: "subscription",
    observedRoute: "claude-cli:subscription"
  }
})

const capability = (parentPiSessionId: string, agent = "worker") => ({
  version: 1 as const,
  endpoint: "http://127.0.0.1:1234/v1/subagent-tool",
  token: `token-${agent}`,
  parentPiSessionId,
  agent,
  targetId: "desktop",
  role: "conversation" as const,
  mode: "auto" as const,
  tools: []
})

describe("PiChildCredentials", () => {
  it("materializes only the non-secret Claude CLI route marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-claude-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: claudeCliConnection.id,
      authKind: "claude-setup-token",
      access: "claude-cli",
      refresh: null,
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)

    const directory = await Effect.runPromise(children.materialize(
      "parent-pi-session",
      [claudeCliConnection],
      [capability("parent-pi-session")]
    ))

    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
      anthropic: {
        type: "oauth",
        access: "claude-cli",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER
      }
    })
  })

  it("keeps the parent account when an assignment uses the same provider", () => {
    expect(childProviderConnections(connection, [
      alternateAnthropicConnection,
      codexConnection
    ])).toEqual([connection, codexConnection])
  })

  it("materializes parent and assigned-provider credentials under restrictive permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("anthropic-api"),
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    await Effect.runPromise(credentials.write({
      connectionId: codexConnection.id,
      authKind: "openai-codex-oauth",
      access: "codex-access",
      refresh: "codex-refresh",
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)

    const directory = await Effect.runPromise(
      children.materialize(
        "parent-pi-session",
        [connection, codexConnection],
        [
          capability("parent-pi-session", "worker"),
          capability("parent-pi-session", "reviewer")
        ]
      )
    )

    expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "secret" },
      "openai-codex": {
        type: "oauth",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Number.MAX_SAFE_INTEGER
      }
    })
    expect(JSON.parse(await readFile(join(directory, "capability-worker.json"), "utf8")))
      .toEqual(capability("parent-pi-session", "worker"))
    expect(JSON.parse(await readFile(join(directory, "capability-reviewer.json"), "utf8")))
      .toEqual(capability("parent-pi-session", "reviewer"))
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, "auth.json"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, "capability-worker.json"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, "capability-reviewer.json"))).mode & 0o777).toBe(0o600)
    }
  })

  it("clears stale parent credentials during runtime recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)
    await Effect.runPromise(children.materialize("stale", [connection], [capability("stale")]))

    await Effect.runPromise(children.clear())

    await expect(access(root)).rejects.toBeTruthy()
  })

  it("removes one parent session without touching another", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-child-auth-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    const children = new PiChildCredentials(root, credentials)
    await Effect.runPromise(children.materialize("one", [connection], [capability("one")]))
    await Effect.runPromise(children.materialize("two", [connection], [capability("two")]))

    await Effect.runPromise(children.remove("one"))

    await expect(access(children.directory("one"))).rejects.toBeTruthy()
    await expect(access(children.directory("two"))).resolves.toBeUndefined()
  })
})

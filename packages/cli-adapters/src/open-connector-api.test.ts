import { FileSystem } from "@effect/platform"
import { Effect, Exit, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { OpenConnectorApi } from "./open-connector-api.js"
import { InMemorySecretStoreLive, SecretStore } from "./secret-store.js"
import { runExit, withTempRoot } from "./test-support.js"

/**
 * OpenConnectorApi is the typed fetch client behind the Connector Center. The
 * contract under test: every call carries the stored bearer, a missing
 * endpoint/token fails with a typed `ConnectorError` (never a raw throw), and a
 * non-OK response is an error — while credentials only ever travel OUT on the
 * request body.
 */
describe("OpenConnectorApi", () => {
  let temp: ReturnType<typeof withTempRoot>
  beforeEach(() => {
    temp = withTempRoot()
  })
  afterEach(() => {
    temp.cleanup()
    vi.unstubAllGlobals()
  })

  const Services = Layer.mergeAll(OpenConnectorApi.Default, ConfigService.Default, InMemorySecretStoreLive)

  const run = <A, E>(
    effect: Effect.Effect<A, E, OpenConnectorApi | ConfigService | SecretStore | AppPaths | FileSystem.FileSystem>
  ) => runExit(effect.pipe(Effect.provide(Services)), temp.layer)

  /** Configure endpoint + token, then run `body`. */
  const configured = <A, E>(
    fn: (
      fetchMock: ReturnType<typeof vi.fn>
    ) => Effect.Effect<A, E, OpenConnectorApi | ConfigService | SecretStore | AppPaths | FileSystem.FileSystem>,
    fetchMock: ReturnType<typeof vi.fn>
  ) =>
    run(
      Effect.gen(function* () {
        yield* ConfigService.setOpenConnector({ endpoint: "https://oc.test", enabled: true, serverName: "open-connector" })
        yield* (yield* SecretStore).setOpenConnectorToken("tok_123")
        return yield* fn(fetchMock)
      })
    )

  it("fails with ConnectorError when no endpoint/token is configured", async () => {
    const exit = await run(OpenConnectorApi.listProviders())
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("attaches the bearer and maps the provider catalog", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "github", name: "GitHub", actionCount: 3, auth: [{ type: "api_key" }] }] }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.listProviders(), fetchMock)
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toHaveLength(1)
      expect(exit.value[0]?.id).toBe("github")
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://oc.test/v1/providers")
    expect(init.headers).toMatchObject({ authorization: "Bearer tok_123" })
  })

  /**
   * The live catalog's exact list shape, captured from
   * `GET /v1/providers` on `ghcr.io/oomol-lab/open-connector`. Two things it
   * pins: `iconUrl` is null (so the UI must derive a logo from `homepageUrl`),
   * and `categories` are objects, not strings.
   */
  it("maps the live catalog shape — categories, homepage, and no_auth", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                service: "linear",
                displayName: "Linear",
                iconUrl: null,
                homepageUrl: "https://linear.app",
                categories: [
                  { id: "Productivity", displayName: "Productivity" },
                  { id: "Developer Tools", displayName: "Developer Tools" }
                ],
                authTypes: ["oauth2", "api_key"]
              },
              {
                service: "hackernews",
                displayName: "Hacker News",
                iconUrl: null,
                homepageUrl: "https://news.ycombinator.com",
                categories: [{ id: "Data", displayName: "Data" }],
                authTypes: ["no_auth"]
              }
            ]
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.listProviders(), fetchMock)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const [linear, hn] = exit.value
    expect(linear).toMatchObject({
      id: "linear",
      name: "Linear",
      icon: null,
      homepageUrl: "https://linear.app",
      categories: ["Productivity", "Developer Tools"],
      authTypes: ["oauth2", "api_key"]
    })
    // The bug this pins: `no_auth` used to be dropped from the union and default
    // to `api_key`, putting a credential form in front of a provider with none.
    expect(hn?.authTypes).toEqual(["no_auth"])
  })

  /**
   * The per-service detail is where the connect form's real shape comes from.
   * Captured from `GET /api/providers/linear`: a provider that offers BOTH modes,
   * with the api-key label/placeholder at the descriptor level and the OAuth
   * scopes on a sibling entry.
   */
  it("folds a provider's auth descriptors into a form, keeping oauth scopes separate", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            service: "linear",
            displayName: "Linear",
            categories: ["Productivity"],
            authTypes: ["oauth2", "api_key"],
            homepageUrl: "https://linear.app",
            auth: [
              {
                type: "oauth2",
                authorizationUrl: "https://linear.app/oauth/authorize",
                scopes: ["read", "write", "issues:create"]
              },
              {
                type: "api_key",
                label: "Personal API Key",
                placeholder: "lin_api_...",
                description: "Create it from Settings > Account > Security & Access.",
                extraFields: []
              }
            ],
            actions: [{ id: "linear.create_linear_issue" }, { id: "linear.create_linear_comment" }]
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.getProvider("linear"), fetchMock)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.fields).toEqual([
      { name: "apiKey", label: "Personal API Key", kind: "password", required: true, placeholder: "lin_api_..." }
    ])
    // The oauth2 descriptor's scopes must NOT leak into the key form — they are
    // client config, collected separately.
    expect(exit.value.oauthScopes).toEqual(["read", "write", "issues:create"])
    expect(exit.value.actionCount).toBe(2)
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    // Never `/api/providers` — the list form of this endpoint is ~5 MB.
    expect(url).toBe("https://oc.test/api/providers/linear")
  })

  /**
   * The live connection shape nests the account under `profile`. Reading it at
   * the root — which is what the mapper used to do — silently produced an empty
   * account name and zero scopes on every connected row.
   */
  it("reads a connection's account out of its nested profile", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "linear:work",
                service: "linear",
                connectionName: "work",
                authType: "oauth2",
                configured: true,
                profile: {
                  accountId: "acct_1",
                  displayName: "Acme Engineering",
                  grantedScopes: ["read", "write"]
                }
              }
            ]
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.listConnections(), fetchMock)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value[0]).toEqual({
      service: "linear",
      accountId: "acct_1",
      displayName: "Acme Engineering",
      grantedScopes: ["read", "write"],
      connectionName: "work",
      status: "connected"
    })
  })

  /**
   * The instance NAMES its default connection "default"; `ConnectorConnection`
   * documents null for it. Without normalizing, the read path spells the default
   * connection one way and the write path another — the instance resolves both to
   * the same record, so nothing breaks, but the domain type stops being true and
   * the next reader has to discover that for themselves.
   */
  it("normalizes the default connection's alias to null", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                service: "hackernews",
                connectionName: "default",
                authType: "no_auth",
                configured: true,
                virtual: true,
                profile: { accountId: "hackernews:public", displayName: "Hacker News Public", grantedScopes: [] }
              },
              {
                service: "linear",
                connectionName: "work",
                configured: true,
                profile: { accountId: "acct_1", displayName: "Acme", grantedScopes: [] }
              }
            ]
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.listConnections(), fetchMock)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value[0]?.connectionName).toBeNull()
    // A real alias is untouched — normalizing it away would delete the wrong one.
    expect(exit.value[1]?.connectionName).toBe("work")
  })

  it("sends the credential OUT on the PUT body and never returns it", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(
      () => OpenConnectorApi.putConnection("github", "api_key", { apiKey: "ghp_secret" }),
      fetchMock
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      // The success value is a plain ack — no echo of the secret.
      expect(JSON.stringify(exit.value)).not.toContain("ghp_secret")
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://oc.test/api/connections/github")
    expect(init.method).toBe("PUT")
    expect(String(init.body)).toContain("ghp_secret")
  })

  it("returns the authorization URL from startAuthorization", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { authorizationUrl: "https://github.com/login/oauth?x=1" } }), { status: 200 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.startAuthorization("github"), fetchMock)
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBe("https://github.com/login/oauth?x=1")
  })

  it("maps a non-OK response to ConnectorError", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 502 }))
    vi.stubGlobal("fetch", fetchMock)
    const exit = await configured(() => OpenConnectorApi.listConnections(), fetchMock)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

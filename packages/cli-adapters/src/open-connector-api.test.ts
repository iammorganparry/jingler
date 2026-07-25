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

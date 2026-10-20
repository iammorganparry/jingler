import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AppPaths } from "./app-paths.js"
import { McpAuthStore } from "./mcp-auth-store.js"
import { McpConfigService } from "./mcp-config-service.js"
import { makeInMemorySecretStore } from "./secret-store.js"
import { runExit, withTempRoot } from "./test-support.js"

/**
 * Runs against a real temp `~/jingler/mcp.json` and asserts observable
 * outcomes: what list/resolve return and what ends up on disk.
 */
describe("McpConfigService", () => {
  let temp: ReturnType<typeof withTempRoot>
  beforeEach(() => {
    temp = withTempRoot()
  })
  afterEach(() => temp.cleanup())

  const provided = <A, E>(
    effect: Effect.Effect<A, E, McpConfigService | AppPaths | FileSystem.FileSystem>
  ) => runExit(effect.pipe(Effect.provide(McpConfigService.Default)), temp.layer)

  const seed = (content: string) => {
    mkdirSync(temp.root, { recursive: true })
    writeFileSync(join(temp.root, "mcp.json"), content)
  }

  const onDisk = () => JSON.parse(readFileSync(join(temp.root, "mcp.json"), "utf8"))

  it("lists an empty catalog when the file does not exist", async () => {
    const exit = await provided(McpConfigService.list())
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toEqual([])
  })

  it("redacts header and env values into key names only", async () => {
    seed(JSON.stringify({
      mcp: {
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          headers: { Authorization: "Bearer literal-secret" }
        },
        local: {
          type: "local",
          command: ["npx", "-y", "some-mcp"],
          environment: { API_KEY: "another-secret" }
        }
      }
    }))
    const exit = await provided(McpConfigService.list())
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const serialized = JSON.stringify(exit.value)
    expect(serialized).not.toContain("literal-secret")
    expect(serialized).not.toContain("another-secret")
    expect(exit.value).toEqual([
      {
        name: "context7",
        displayName: "context7",
        iconUrl: null,
        authKind: "none",
        authState: "not-required",
        transport: "http",
        scope: "user",
        target: "https://mcp.context7.com/mcp",
        envKeys: [],
        headerKeys: ["Authorization"],
        enabled: true,
        disabledTools: []
      },
      {
        name: "local",
        displayName: "local",
        iconUrl: null,
        authKind: "none",
        authState: "not-required",
        transport: "stdio",
        scope: "user",
        target: "npx -y some-mcp",
        envKeys: ["API_KEY"],
        headerKeys: [],
        enabled: true,
        disabledTools: []
      }
    ])
  })

  it("resolves enabled entries with {env:VAR} interpolation and skips disabled ones", async () => {
    seed(JSON.stringify({
      mcp: {
        api: {
          type: "remote",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer {env:MY_TOKEN}" }
        },
        off: { type: "remote", url: "https://off.example.com", enabled: false }
      }
    }))
    const exit = await provided(McpConfigService.resolve({ MY_TOKEN: "tok-123" }))
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toEqual([
      {
        name: "api",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer tok-123" }
      }
    ])
  })

  it("does not reuse a managed credential after the endpoint changes", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    const auth = new McpAuthStore(secrets)
    seed(JSON.stringify({ mcp: {
      api: {
        type: "remote",
        url: "https://one.example.com/mcp",
        auth: { type: "api-key", header: "X-API-Key" }
      }
    } }))
    const first = await provided(McpConfigService.parsed())
    expect(first._tag).toBe("Success")
    if (first._tag !== "Success" || first.value[0]?.credentialIdentity === undefined) return
    await Effect.runPromise(auth.write("api", {
      type: "api-key",
      identity: first.value[0].credentialIdentity,
      apiKey: "secret"
    }))
    const authenticated = await provided(McpConfigService.resolveAuthenticated(secrets))
    expect(authenticated._tag === "Success" && authenticated.value[0]).toMatchObject({
      headers: { "X-API-Key": "secret" }
    })

    seed(JSON.stringify({ mcp: {
      api: {
        type: "remote",
        url: "https://two.example.com/mcp",
        auth: { type: "api-key", header: "X-API-Key" }
      }
    } }))
    const replaced = await provided(McpConfigService.resolveAuthenticated(secrets))
    expect(replaced._tag === "Success" && replaced.value[0]).toMatchObject({ headers: {} })
  })

  it("keeps a local cwd in runtime and probe launch details", async () => {
    seed(JSON.stringify({
      mcp: { local: { type: "local", command: ["node", "server.js"], cwd: "/tmp/mcp" } }
    }))
    const runtime = await provided(McpConfigService.resolve({}))
    const parsed = await provided(McpConfigService.parsed({}))
    expect(runtime._tag === "Success" && runtime.value[0]).toMatchObject({ cwd: "/tmp/mcp" })
    expect(parsed._tag === "Success" && parsed.value[0]?.launch).toMatchObject({ cwd: "/tmp/mcp" })
  })

  it("resolve skips reserved names without dropping valid entries", async () => {
    seed(JSON.stringify({ mcp: {
      browser: { type: "remote", url: "https://reserved.example.com" },
      valid: { type: "remote", url: "https://valid.example.com" }
    } }))
    const resolved = await provided(McpConfigService.resolve({}))
    expect(resolved._tag === "Success" && resolved.value).toEqual([
      expect.objectContaining({ name: "valid" })
    ])
  })

  it("resolve never fails on a malformed file, list reports the problem", async () => {
    seed("{ not json")
    const resolved = await provided(McpConfigService.resolve({}))
    expect(resolved._tag).toBe("Success")
    if (resolved._tag === "Success") expect(resolved.value).toEqual([])
    const listed = await provided(McpConfigService.list())
    expect(listed._tag).toBe("Failure")
  })

  it("write/setEnabled/remove round-trip through the file", async () => {
    const exit = await provided(
      Effect.gen(function* () {
        yield* McpConfigService.write("context7", {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          headers: {},
          enabled: true
        })
        yield* McpConfigService.setEnabled("context7", false)
        yield* McpConfigService.write("gone", {
          type: "local",
          command: ["npx", "x"],
          environment: {},
          enabled: true
        })
        yield* McpConfigService.remove("gone")
        return yield* McpConfigService.list()
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toEqual([expect.objectContaining({ name: "context7", enabled: false })])
    expect(Object.keys(onDisk().mcp)).toEqual(["context7"])
  })

  it("rejects reserved names and preserves unknown top-level keys on rewrite", async () => {
    seed(JSON.stringify({ $schema: "https://example.com/schema.json", mcp: {} }))
    const reserved = await provided(
      McpConfigService.write("jingler-browser", {
        type: "remote",
        url: "https://x.example.com",
        headers: {},
        enabled: true
      })
    )
    expect(reserved._tag).toBe("Failure")
    const ok = await provided(
      McpConfigService.write("fine", {
        type: "remote",
        url: "https://x.example.com",
        headers: {},
        enabled: true
      })
    )
    expect(ok._tag).toBe("Success")
    expect(onDisk().$schema).toBe("https://example.com/schema.json")
  })

  it("preserves entry fields when changing enabled state or authentication", async () => {
    seed(JSON.stringify({
      mcp: { context7: { type: "remote", url: "https://example.com", timeout: 30 } }
    }))
    await provided(McpConfigService.setEnabled("context7", false))
    await provided(McpConfigService.setAuth("context7", { type: "oauth" }))
    expect(onDisk().mcp.context7).toMatchObject({ timeout: 30, enabled: false, auth: { type: "oauth" } })
    expect(statSync(join(temp.root, "mcp.json")).mode & 0o777).toBe(0o600)
  })

  it("rejects OAuth setup for an SSE server", async () => {
    seed(JSON.stringify({ mcp: { legacy: {
      type: "remote",
      url: "https://example.com/sse",
      transport: "sse"
    } } }))
    const exit = await provided(McpConfigService.setAuth("legacy", { type: "oauth" }))
    expect(exit._tag).toBe("Failure")
    expect(onDisk().mcp.legacy.auth).toBeUndefined()
  })

  it("persists disabled tool names and survives reopening (re-reading the file)", async () => {
    seed(JSON.stringify({
      mcp: { api: { type: "remote", url: "https://example.com/mcp", headers: {} } }
    }))
    await provided(McpConfigService.setDisabledTools("api", ["dangerous_delete"]))
    expect(onDisk().mcp.api.disabledTools).toEqual(["dangerous_delete"])
    const relisted = await provided(McpConfigService.list())
    expect(relisted._tag === "Success" && relisted.value[0]).toMatchObject({
      disabledTools: ["dangerous_delete"]
    })
  })

  it("setDisabledTools fails for a server that does not exist", async () => {
    const exit = await provided(McpConfigService.setDisabledTools("missing", ["x"]))
    expect(exit._tag).toBe("Failure")
  })

  it("signOut clears only the stored OAuth credential, leaving the server config untouched", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    const auth = new McpAuthStore(secrets)
    seed(JSON.stringify({
      mcp: { api: { type: "remote", url: "https://example.com/mcp", auth: { type: "oauth" } } }
    }))
    const parsed = await provided(McpConfigService.parsed())
    expect(parsed._tag).toBe("Success")
    if (parsed._tag !== "Success" || parsed.value[0]?.credentialIdentity === undefined) return
    const identity = parsed.value[0].credentialIdentity
    await Effect.runPromise(auth.write("api", { type: "oauth", identity, tokens: { access_token: "tok", token_type: "bearer" } }))
    expect(await Effect.runPromise(auth.read("api", identity))).not.toBeNull()

    const exit = await provided(McpConfigService.signOut("api", secrets))
    expect(exit._tag).toBe("Success")
    expect(await Effect.runPromise(auth.read("api", identity))).toBeNull()
    // The server config itself — not disabled, not removed — is untouched.
    expect(onDisk().mcp.api).toMatchObject({ type: "remote", url: "https://example.com/mcp" })
  })

  it("signOut fails for a server that is not OAuth", async () => {
    const secrets = await Effect.runPromise(makeInMemorySecretStore())
    seed(JSON.stringify({
      mcp: { api: { type: "remote", url: "https://example.com/mcp" } }
    }))
    const exit = await provided(McpConfigService.signOut("api", secrets))
    expect(exit._tag).toBe("Failure")
  })

  it("refuses to mutate a malformed file rather than clobbering it", async () => {
    seed("{ broken")
    const exit = await provided(
      McpConfigService.write("fine", {
        type: "remote",
        url: "https://x.example.com",
        headers: {},
        enabled: true
      })
    )
    expect(exit._tag).toBe("Failure")
    expect(readFileSync(join(temp.root, "mcp.json"), "utf8")).toBe("{ broken")
  })
})

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { migrateMcpConfig } from "./mcp-migration.js"
import { InMemorySecretStoreLive, SecretStore } from "./secret-store.js"
import { runExit, withTempRoot } from "./test-support.js"

describe("migrateMcpConfig", () => {
  let temp: ReturnType<typeof withTempRoot>
  beforeEach(() => {
    temp = withTempRoot()
    mkdirSync(temp.root, { recursive: true })
  })
  afterEach(() => temp.cleanup())

  const run = (token: string | null = null) =>
    runExit(
      Effect.gen(function* () {
        const secrets = yield* SecretStore
        if (token !== null) yield* secrets.setOpenConnectorToken(token)
        yield* migrateMcpConfig
        return yield* secrets.getOpenConnectorToken
      }).pipe(Effect.provide(InMemorySecretStoreLive)),
      temp.layer
    )

  const mcpJson = () => JSON.parse(readFileSync(join(temp.root, "mcp.json"), "utf8"))

  it("migrates an enabled OpenConnector config into a remote entry and clears the bearer", async () => {
    writeFileSync(join(temp.root, "config.json"), JSON.stringify({
      reposDir: null,
      createdAt: "2024-01-01T00:00:00Z",
      openConnector: { endpoint: "https://connector.example/", enabled: true, serverName: "operator-tools" }
    }))
    const exit = await run("bearer-secret")
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
    expect(mcpJson().mcp["operator-tools"]).toEqual({
      type: "remote",
      url: "https://connector.example/mcp",
      headers: { Authorization: "Bearer bearer-secret" },
      enabled: true
    })
  })

  it("does nothing when OpenConnector is disabled and no imports exist", async () => {
    writeFileSync(join(temp.root, "config.json"), JSON.stringify({
      reposDir: null,
      createdAt: "2024-01-01T00:00:00Z",
      openConnector: { endpoint: "https://connector.example", enabled: false }
    }))
    await run("bearer-secret")
    expect(existsSync(join(temp.root, "mcp.json"))).toBe(false)
  })

  it("migrates the imported managed catalog and removes its metadata file", async () => {
    const importedDir = join(temp.root, "agent-resources")
    mkdirSync(importedDir, { recursive: true })
    writeFileSync(join(importedDir, "mcp.json"), JSON.stringify([
      {
        id: "docs",
        name: "Docs",
        kind: "mcp",
        enabled: true,
        trust: "operator-approved",
        scope: { kind: "device-local", targetId: "desktop" },
        availability: { state: "available", targetId: "desktop", reason: null },
        provenance: {
          origin: "claude",
          sourceRoot: "/tmp",
          sourcePath: "/tmp/.claude.json",
          importedAt: "2024-01-01T00:00:00Z"
        },
        transport: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp"],
        envKeys: []
      }
    ]))
    await run()
    expect(mcpJson().mcp["docs"]).toEqual({
      type: "local",
      command: ["npx", "-y", "docs-mcp"],
      environment: {},
      enabled: true
    })
    expect(existsSync(join(importedDir, "mcp.json"))).toBe(false)
  })

  it("never touches an existing mcp.json", async () => {
    writeFileSync(join(temp.root, "mcp.json"), JSON.stringify({ mcp: { keep: { type: "remote", url: "https://x" } } }))
    writeFileSync(join(temp.root, "config.json"), JSON.stringify({
      reposDir: null,
      createdAt: "2024-01-01T00:00:00Z",
      openConnector: { endpoint: "https://connector.example", enabled: true }
    }))
    const exit = await run("bearer-secret")
    expect(exit._tag).toBe("Success")
    // Token untouched too: nothing migrated.
    if (exit._tag === "Success") expect(exit.value).toBe("bearer-secret")
    expect(mcpJson()).toEqual({ mcp: { keep: { type: "remote", url: "https://x" } } })
  })
})

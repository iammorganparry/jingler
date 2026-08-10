import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ManagedMcpImportInput,
  ManagedResourceId,
  type ManagedMcpImportInput as ManagedMcpImportInputType
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeInMemorySecretStore } from "../../secret-store.js"
import { AgentSecretStore } from "../auth/agent-secret-store.js"
import { makeImportedMcpService } from "./imported-mcp-service.js"

const roots: string[] = []
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-imported-mcp-"))
  roots.push(root)
  return root
}
const resourceId = (value: string) => Schema.decodeUnknownSync(ManagedResourceId)(value)
const input = (value: object): ManagedMcpImportInputType =>
  Schema.decodeUnknownSync(ManagedMcpImportInput)({
    id: "docs",
    name: "Docs",
    scope: { kind: "device-local", targetId: "desktop" },
    targetId: "desktop",
    provenance: {
      origin: "jingler",
      sourceRoot: "/managed",
      sourcePath: "/managed/mcp.json",
      importedAt: null
    },
    ...value
  })

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("ImportedMcpService", () => {
  it("round-trips HTTP, SSE, and stdio metadata with encrypted launch values", async () => {
    const root = await temporary()
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    const secrets = new AgentSecretStore(backing)
    const metadataFile = join(root, "mcp.json")
    const service = await Effect.runPromise(makeImportedMcpService({ metadataFile, secrets }))

    await Effect.runPromise(service.importServer(input({
      transport: "http",
      url: "https://mcp.example.test/rpc",
      headers: { Authorization: "Bearer private-http" }
    })))
    await Effect.runPromise(service.importServer(input({
      id: "events",
      name: "Events",
      transport: "sse",
      url: "https://mcp.example.test/events",
      headers: { "X-Token": "private-sse" }
    })))
    await Effect.runPromise(service.importServer(input({
      id: "local",
      name: "Local",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { ACCESS_TOKEN: "private-stdio" }
    })))

    const metadata = await Effect.runPromise(service.list)
    expect(metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "docs", transport: "http", headerKeys: ["Authorization"] }),
      expect.objectContaining({ id: "events", transport: "sse", headerKeys: ["X-Token"] }),
      expect.objectContaining({ id: "local", transport: "stdio", envKeys: ["ACCESS_TOKEN"] })
    ]))
    const persistedMetadata = await readFile(metadataFile, "utf8")
    expect(persistedMetadata).not.toMatch(/private-http|private-sse|private-stdio/u)

    const resolved = await Effect.runPromise(service.resolveForTarget("desktop"))
    expect(resolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "docs", headers: { Authorization: "Bearer private-http" } }),
      expect.objectContaining({ id: "local", env: { ACCESS_TOKEN: "private-stdio" } })
    ]))

    const duplicate = await Effect.runPromise(Effect.either(service.importServer(input({
      transport: "http",
      url: "https://replacement.example.test",
      headers: { Authorization: "replacement" }
    }))))
    expect(duplicate._tag).toBe("Left")
    expect(await Effect.runPromise(secrets.readMcp("docs", "desktop"))).toMatchObject({
      headers: { Authorization: "Bearer private-http" }
    })
  })

  it("rejects malformed transports, reserved ids, and unavailable target scopes", async () => {
    const root = await temporary()
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    const service = await Effect.runPromise(makeImportedMcpService({
      metadataFile: join(root, "mcp.json"),
      secrets: new AgentSecretStore(backing)
    }))
    const cases = [
      input({ transport: "http", url: "file:///tmp/socket", headers: {} }),
      input({ id: "browser", transport: "http", url: "https://example.test", headers: {} }),
      input({
        transport: "stdio",
        command: "node",
        args: [],
        env: {},
        scope: { kind: "device-local", targetId: "remote" }
      })
    ]

    for (const candidate of cases) {
      const result = await Effect.runPromise(Effect.either(service.importServer(candidate)))
      expect(result._tag).toBe("Left")
    }
    expect(await Effect.runPromise(service.list)).toEqual([])
  })

  it("disables and removes metadata together with target-local secrets", async () => {
    const root = await temporary()
    const backing = await Effect.runPromise(makeInMemorySecretStore())
    const secrets = new AgentSecretStore(backing)
    const service = await Effect.runPromise(makeImportedMcpService({
      metadataFile: join(root, "mcp.json"),
      secrets
    }))
    await Effect.runPromise(service.importServer(input({
      transport: "http",
      url: "https://example.test",
      headers: { Authorization: "private" }
    })))

    await Effect.runPromise(service.setEnabled(resourceId("docs"), false))
    expect(await Effect.runPromise(service.resolveForTarget("desktop"))).toEqual([])
    await Effect.runPromise(service.remove(resourceId("docs")))
    expect(await Effect.runPromise(service.list)).toEqual([])
    expect(await Effect.runPromise(secrets.readMcp("docs", "desktop"))).toBeNull()
  })
})

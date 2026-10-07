import { createServer } from "node:net"
import { describe, expect, it } from "vitest"
import { allocateWorkspacePorts, resolveWorkspacePreview, trustedWorkspaceEnvironment, workspaceEnvironment, workspacePortAvailable } from "./workspace-ports.js"

describe("workspace ports", () => {
  it.each(["127.0.0.1", "::1"])("probes occupied loopback %s and closes successful probes", async (host) => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host, port: 0 }, resolve) })
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing TCP address")
    try { expect(await workspacePortAvailable(address.port)).toBe(false) }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
    expect(await workspacePortAvailable(address.port)).toBe(true)
  })
  it("allocates primary and extra ports without duplicates", async () => {
    const ports = await allocateWorkspacePorts([], { primary: 32000, extras: [{ name: "API", start: 32000 }] })
    expect(ports.primary).not.toBe(ports.extras.API)
  })
  it("restricts templates and extra names", async () => {
    expect(resolveWorkspacePreview("http://localhost:{API_port}/x", { primary: 3100, extras: { API: 3101 } })).toBe("http://localhost:3101/x")
    expect(() => resolveWorkspacePreview("javascript:alert(1)", { primary: 3100, extras: {} })).toThrow()
    expect(() => resolveWorkspacePreview("http://localhost:{BAD_port}", { primary: 3100, extras: {} })).toThrow()
    await expect(allocateWorkspacePorts([], { primary: 3100, extras: [{ name: "api", start: 3100 }] })).rejects.toThrow()
  })
  it("passes only workspace keys, never credential keys", () => {
    expect(trustedWorkspaceEnvironment({ JINGLER_PORT: "3100", JINGLER_API_PORT: "3101", ANTHROPIC_API_KEY: "secret", JINGLER_PORT_TOKEN: "secret", JINGLER_BAD_PORT: "secret" })).toEqual({ JINGLER_PORT: "3100", JINGLER_API_PORT: "3101" })
    expect(workspaceEnvironment({ environmentId: "remote", worktreePath: "/tmp/work", repoPath: "/tmp/root", workspacePorts: { primary: 3100, extras: {} } })).toEqual({})
  })
})

 it("skips listeners without permanently reserving probe sockets", async () => {
   const ports = await allocateWorkspacePorts([], { primary: 3100, extras: [] }, async (port) => port !== 3100)
   expect(ports.primary).toBe(3101)
 })

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"

/** Fake `GET /v0.1/servers`: one hosted remote, shaped like the live registry. */
const startFakeRegistry = async (): Promise<{ url: string; queries: string[]; close: () => Promise<void> }> => {
  const queries: string[] = []
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    queries.push(url.searchParams.get("search") ?? "")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      servers: [{ server: {
        name: "app.linear/linear",
        title: "Linear",
        description: "Find and manage issues.",
        remotes: [{ type: "streamable-http", url: "https://mcp.linear.example/mcp", headers: [] }]
      } }],
      metadata: { count: 1 }
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v0.1/servers`, queries, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

test("Discover imports a Codex server and adds one from the MCP registry", async ({ launchApp }) => {
  const registry = await startFakeRegistry()
  try {
    const { window, home } = await launchApp({
      configured: true,
      withRepo: true,
      e2eEnv: { JINGLER_MCP_REGISTRY_URL: registry.url },
      seed: ({ home: root }) => {
        mkdirSync(join(root, ".codex"), { recursive: true })
        writeFileSync(join(root, ".codex", "config.toml"), '[mcp_servers.context7]\nurl = "https://mcp.context7.example/mcp"\n')
      }
    })
    const notNow = window.getByTestId("import-card").getByRole("button", { name: "Not now" })
    if (await notNow.isVisible().catch(() => false)) await notNow.click()

    await window.getByRole("button", { name: "Account menu" }).click()
    await window.getByRole("menuitem", { name: "Settings" }).click()
    await window.getByRole("button", { name: "MCP servers", exact: true }).click()
    await window.getByRole("tab", { name: "Discover" }).click()

    const mcpJson = () => {
      try {
        return JSON.parse(readFileSync(join(home, "jingler", "mcp.json"), "utf8")).mcp as Record<string, { url?: string }>
      } catch {
        return {} as Record<string, { url?: string }>
      }
    }

    // Other harnesses' servers sit above the registry.
    const codex = window.getByRole("region", { name: "Codex servers" })
    await codex.getByRole("button", { name: "Import context7" }).click()
    await expect.poll(() => mcpJson().context7?.url).toBe("https://mcp.context7.example/mcp")
    await expect(codex.getByText("Added")).toBeVisible({ timeout: 15_000 })

    // Registry search reaches main and the entry lands in mcp.json.
    const registrySection = window.getByRole("region", { name: "Registry servers" })
    await window.getByPlaceholder("Search registry").fill("linear")
    await expect.poll(() => registry.queries.includes("linear")).toBe(true)
    await registrySection.getByRole("button", { name: "Add Linear" }).click()
    // Registry adds are confirmed first, showing exactly what will be connected.
    const confirm = window.getByRole("dialog", { name: "Add Linear?" })
    await expect(confirm.getByText("https://mcp.linear.example/mcp")).toBeVisible()
    await confirm.getByRole("button", { name: "Add server" }).click()
    await expect.poll(() => mcpJson().linear?.url).toBe("https://mcp.linear.example/mcp")

    // Both show up in Yours.
    await window.getByRole("tab", { name: "Yours" }).click()
    await expect(window.getByRole("button", { name: "Open context7 details" })).toBeVisible()
    await expect(window.getByRole("button", { name: "Open Linear details" })).toBeVisible()
  } finally {
    await registry.close()
  }
})

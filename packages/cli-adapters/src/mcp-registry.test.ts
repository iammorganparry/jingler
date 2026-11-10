import { describe, expect, it, vi } from "vitest"
import { parseMcpRegistry, registrySlug, searchMcpRegistry } from "./mcp-registry.js"

// Shapes copied from a live `GET /v0.1/servers?search=linear` response.
const page = {
  servers: [
    { server: {
      name: "app.linear/linear",
      title: "Linear",
      description: "Find and manage issues.",
      icons: [{ src: "https://static.linear.app/integrations/mcp/icon.svg" }],
      remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp", headers: [] }]
    } },
    { server: {
      name: "io.github.Evozim/linear-broker",
      description: "Paid broker.",
      remotes: [{ type: "sse", url: "https://broker.example/api/mcp", headers: [{ name: "payment-signature", isRequired: true }] }]
    } },
    { server: {
      name: "io.github.acme/postgres-mcp",
      description: "Query Postgres.",
      packages: [{ registryType: "npm", identifier: "@acme/postgres-mcp", version: "1.2.3", transport: { type: "stdio" }, environmentVariables: [{ name: "DATABASE_URL", isRequired: true }] }]
    } },
    { server: { name: "app.linear/linear", description: "duplicate version" } },
    { server: { broken: true } }
  ]
}

describe("parseMcpRegistry", () => {
  it("maps a hosted remote to a streamable HTTP entry with its icon", () => {
    const [linear] = parseMcpRegistry(page)
    expect(linear).toMatchObject({
      registryName: "app.linear/linear",
      name: "linear",
      displayName: "Linear",
      iconUrl: "https://static.linear.app/integrations/mcp/icon.svg",
      kind: "Remote",
      problem: null,
      entry: { type: "remote", url: "https://mcp.linear.app/mcp", enabled: true }
    })
  })

  it("maps npm packages to npx with env placeholders, never secret values", () => {
    const pg = parseMcpRegistry(page).find((entry) => entry.name === "postgres-mcp")
    expect(pg).toMatchObject({
      kind: "Local · npx",
      problem: null,
      entry: { type: "local", command: ["npx", "-y", "@acme/postgres-mcp@1.2.3"], environment: { DATABASE_URL: "{env:DATABASE_URL}" } }
    })
  })

  it("pins pypi packages with == and leaves a 'latest' version unpinned", () => {
    const [py, latest] = parseMcpRegistry({ servers: [
      { server: { name: "io.github.acme/py-mcp", packages: [{ registryType: "pypi", identifier: "py-mcp", version: "0.4.0" }] } },
      { server: { name: "io.github.acme/edge-mcp", packages: [{ registryType: "npm", identifier: "edge-mcp", version: "latest" }] } }
    ] })
    expect(py?.entry).toMatchObject({ command: ["uvx", "py-mcp==0.4.0"] })
    expect(latest?.entry).toMatchObject({ command: ["npx", "-y", "edge-mcp"] })
  })

  it("flags servers it can't set up, drops duplicates and malformed rows", () => {
    const entries = parseMcpRegistry(page)
    expect(entries.map((entry) => entry.registryName)).toEqual([
      "app.linear/linear",
      "io.github.Evozim/linear-broker",
      "io.github.acme/postgres-mcp"
    ])
    expect(entries[1]).toMatchObject({ entry: null, problem: expect.stringContaining("headers") })
    expect(parseMcpRegistry({ nope: 1 })).toEqual([])
  })

  it("slugs registry names into valid mcp.json names", () => {
    expect(registrySlug("io.github.Foo/My Server!")).toBe("my-server")
    expect(registrySlug("x/__")).toBe("server")
  })
})

describe("searchMcpRegistry", () => {
  it("asks for latest versions with the search term", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(page)))
    await searchMcpRegistry(" linear ", fetchImpl as unknown as typeof fetch)
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [URL])[0]))
    expect(url.searchParams.get("search")).toBe("linear")
    expect(url.searchParams.get("version")).toBe("latest")
  })

  it("throws on a failed response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }))
    await expect(searchMcpRegistry("", fetchImpl as unknown as typeof fetch)).rejects.toThrow("503")
  })
})

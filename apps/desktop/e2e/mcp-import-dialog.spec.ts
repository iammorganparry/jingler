import { join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { expect, test } from "./fixtures.js"
import { startFakeOAuthMcpServer } from "./fake-oauth-mcp-server.js"

test("presents discovered MCP servers with a readable stacked header", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    seed: ({ home }) => {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://linear.example/mcp" },
          docs: { command: "node", args: ["docs-server.mjs"] }
        }
      }))
    }
  })

  await window.getByTestId("import-card").getByRole("button", { name: "Review" }).click()

  const dialog = window.getByRole("dialog")
  await expect(dialog).toBeVisible()
  const title = dialog.getByRole("heading", { name: "Import MCP servers" })
  const description = dialog.getByText(/Found 2 servers/)
  await expect(title).toBeVisible()
  await expect(description).toBeVisible()
  const titleBox = await title.boundingBox()
  const descriptionBox = await description.boundingBox()
  expect(titleBox).not.toBeNull()
  expect(descriptionBox).not.toBeNull()
  expect(descriptionBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height)
  await expect(dialog.getByRole("button", { name: "Import 2 servers" })).toBeVisible()
})

test("flags a discovered server that clashes with an existing one with a read-only ConflictBadge", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    seed: ({ home }) => {
      const jinglerDir = join(home, "jingler")
      mkdirSync(jinglerDir, { recursive: true })
      writeFileSync(join(jinglerDir, "mcp.json"), JSON.stringify({
        mcp: { linear: { type: "local", command: ["node", "existing.mjs"] } }
      }))
      writeFileSync(join(home, ".claude.json"), JSON.stringify({
        mcpServers: { linear: { command: "node", args: ["docs-server.mjs"] } }
      }))
    }
  })

  await window.getByTestId("import-card").getByRole("button", { name: "Review" }).click()

  const dialog = window.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Conflict")).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "Keep mine" })).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "Replace" })).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "Keep both" })).toBeVisible()
})

test("imports a conflicting server as a new name when the operator picks Keep both", async ({ launchApp }) => {
  const { window, home } = await launchApp({
    configured: true,
    seed: ({ home }) => {
      const jinglerDir = join(home, "jingler")
      mkdirSync(jinglerDir, { recursive: true })
      writeFileSync(join(jinglerDir, "mcp.json"), JSON.stringify({
        mcp: { linear: { type: "local", command: ["node", "existing.mjs"] } }
      }))
      writeFileSync(join(home, ".claude.json"), JSON.stringify({
        mcpServers: { linear: { command: "node", args: ["docs-server.mjs"] } }
      }))
    }
  })

  await window.getByTestId("import-card").getByRole("button", { name: "Review" }).click()

  const dialog = window.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("tab", { name: "Keep both" }).click()
  await dialog.getByRole("button", { name: /Import \d server/ }).click()
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(dialog).toBeHidden()

  const mcpJson = JSON.parse(readFileSync(join(home, "jingler", "mcp.json"), "utf8"))
  expect(mcpJson.mcp["linear"]).toMatchObject({ command: ["node", "existing.mjs"] })
  expect(mcpJson.mcp["linear-2"]).toMatchObject({ command: ["node", "docs-server.mjs"] })
})

test("offers servers only in ~/.claude/settings.json and managed-mcp.json, labelled by origin", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    seed: ({ home }) => {
      mkdirSync(join(home, ".claude"), { recursive: true })
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        mcpServers: { "clive-memory": { command: "node", args: ["memory.js"] } }
      }))
      writeFileSync(join(home, "managed-mcp.json"), JSON.stringify({
        mcpServers: { corp: { type: "http", url: "https://corp.example/mcp" } }
      }))
    }
  })

  await window.getByTestId("import-card").getByRole("button", { name: "Review" }).click()

  const dialog = window.getByRole("dialog")
  await expect(dialog.getByText(/Found 2 servers/)).toBeVisible()
  await expect(dialog.getByText("clive-memory", { exact: true })).toBeVisible()
  await expect(dialog.getByText("User settings")).toBeVisible()
  await expect(dialog.getByText("Managed")).toBeVisible()
  await dialog.getByRole("button", { name: "Import 2 servers" }).click()
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(dialog).toBeHidden()
})

test("shows neutral import results with Connect for OAuth and View log for a failed server", async ({ launchApp }) => {
  // A real 401 from the fake OAuth server makes the probe report needs-auth, not a network failure.
  const mcp = await startFakeOAuthMcpServer()
  try {
    const { window } = await launchApp({
      configured: true,
      seed: ({ home }) => {
        writeFileSync(join(home, ".claude.json"), JSON.stringify({
          mcpServers: { broken: { command: "jingler-no-such-binary-488" } }
        }))
        // opencode's `oauth` key is what makes an imported server managed OAuth.
        mkdirSync(join(home, ".config", "opencode"), { recursive: true })
        writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
          mcp: { linear: { type: "remote", url: mcp.url, oauth: {} } }
        }))
      }
    })

    await window.getByTestId("import-card").getByRole("button", { name: "Review" }).click()

    const dialog = window.getByRole("dialog")
    await dialog.getByRole("button", { name: "Import 2 servers" }).click()
    await expect(dialog.getByRole("heading", { name: "Import complete" })).toBeVisible()
    await expect(dialog.getByText("Failed to start")).toHaveCount(1)
    await expect(dialog.getByText("Needs sign-in")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Connect" })).toBeVisible()
    await dialog.getByRole("button", { name: "View log" }).click()
    await expect(window.getByRole("log", { name: "Server log" })).toBeVisible()
  } finally {
    await mcp.close()
  }
})

test("Settings › MCP servers offers the import found on Home, even after Home's card is dismissed", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    seed: ({ home }) => {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["d.mjs"] } } }))
    }
  })
  const home = window.getByTestId("import-card")
  await expect(home.getByText(/Found 1 server/)).toBeVisible()
  await home.getByRole("button", { name: "Not now" }).click()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "MCP servers" }).click()
  await expect(window.getByText("No servers configured yet.")).toBeVisible()
  const card = window.getByTestId("import-card")
  await expect(card.getByText(/Found 1 server/)).toBeVisible()
  await card.getByRole("button", { name: "Review" }).click()
  await expect(window.getByRole("button", { name: "Import 1 server" })).toBeVisible()
})

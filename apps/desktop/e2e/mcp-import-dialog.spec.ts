import { join } from "node:path"
import { writeFileSync } from "node:fs"
import { expect, test } from "./fixtures.js"

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

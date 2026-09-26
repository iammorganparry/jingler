import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, openSessionByTitle, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * An MCP server that needs auth surfaces a recovery card above the
 * conversation. It must read as MCP (not a provider or runtime failure), and
 * the operator can dismiss it — for the rest of the run, across session
 * switches — without authorizing.
 */

const session = (id: string, title: string): SeedSession => ({
  id,
  repo: "widget",
  branch: `chore/${id}`,
  title,
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-09-26T00:00:00.000Z"
})

test("an MCP reconnect card is labelled as MCP and can be dismissed", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [session("s_mcp_1", "First session"), session("s_mcp_2", "Second session")],
    seed: ({ home }) => {
      const jinglerDir = join(home, "jingler")
      mkdirSync(jinglerDir, { recursive: true })
      writeFileSync(join(jinglerDir, "mcp.json"), JSON.stringify({
        mcp: {
          runpod: { type: "remote", url: "https://runpod.example/mcp", auth: { type: "oauth" } }
        }
      }))
    }
  })

  await openSessionByTitle(window, "First session")
  const card = window.getByRole("region", { name: "MCP server recovery" })
  await expect(card).toBeVisible()
  await expect(card.getByText("MCP server", { exact: true })).toBeVisible()
  await expect(card.getByText("Reconnect runpod")).toBeVisible()
  await expect(card.getByRole("button", { name: "Authorize" })).toBeVisible()

  await card.getByRole("button", { name: "Dismiss: Reconnect runpod" }).click()
  await expect(card).toHaveCount(0)

  // Stays dismissed when the conversation pane remounts for another session.
  await openSessionByTitle(window, "Second session")
  await openSessionByTitle(window, "First session")
  await expect(window.getByRole("region", { name: "MCP server recovery" })).toHaveCount(0)
})

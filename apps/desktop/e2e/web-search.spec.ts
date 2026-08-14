import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const startSearchServer = async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/search" || request.method !== "POST") {
      response.writeHead(404).end()
      return
    }
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      const parsed = JSON.parse(body) as { query?: string }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        results: [{
          title: "Jingler search fixture",
          url: "https://example.test/citation",
          text: `Result for ${parsed.query ?? "query"}`,
          publishedDate: "2026-01-01"
        }]
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Search fixture did not bind")
  return {
    url: `http://127.0.0.1:${address.port}/search`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("configures, redacts, syncs, and clears WebSearch", async ({ launchApp }) => {
  const search = await startSearchServer()
  try {
    const app = await launchApp({
      configured: true,
      withRepo: true,
      e2eEnv: { JINGLER_EXA_URL: search.url }
    })
    const { window, home } = app
    await expect(appShell(window)).toBeVisible()
    await window.getByRole("button", { name: "Account menu" }).click()
    await window.getByRole("menuitem", { name: "Settings" }).click()
    await window.getByRole("button", { name: "General" }).click()

    const section = window.getByRole("region", { name: "Web search" })
    await expect(section).toBeVisible()
    await section.getByLabel("EXA API key").fill("exa-e2e-secret")
    await section.getByRole("button", { name: "Save" }).click()
    await expect(section.getByText("Encrypted locally · synced for Cloud")).toBeVisible()
    await expect(section.getByLabel("EXA API key")).toHaveValue("")

    await expect.poll(() => {
      const config = JSON.parse(
        readFileSync(join(home, "jingler", "config.json"), "utf8")
      ) as { webSearch?: unknown }
      return {
        webSearch: config.webSearch,
        containsKey: JSON.stringify(config).includes("exa-e2e-secret")
      }
    }).toEqual({
      webSearch: { setup: "configured", provider: "exa" },
      containsKey: false
    })

    await section.getByRole("button", { name: "Clear" }).click()
    await expect(section.getByText("No saved key")).toBeVisible()
  } finally {
    await search.close()
  }
})

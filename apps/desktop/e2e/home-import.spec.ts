/** Home import card (#476): dismissal persists across relaunch. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

test("dismissing the Home import card keeps it dismissed after relaunch", async ({ launchApp }) => {
  const seed = ({ home }: { home: string }) => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: { command: "node", args: ["d.mjs"] } } }))
  }
  const first = await launchApp({ configured: true, seed })
  await expect(appShell(first.window)).toBeVisible()
  const card = first.window.getByTestId("import-card")
  await expect(card.getByText(/Found 1 server/)).toBeVisible()
  await card.getByRole("button", { name: "Not now" }).click()
  await expect(card).toHaveCount(0)
  await first.app.close()

  const second = await launchApp({ home: first.home, reposDir: first.reposDir, userDataDir: first.userDataDir, configured: true, seed })
  await expect(appShell(second.window)).toBeVisible()
  await expect(second.window.getByTestId("import-card")).toHaveCount(0)
})

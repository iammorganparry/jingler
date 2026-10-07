import { mkdir, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"

test("Obsidian previews a configured local vault and refreshes external edits", async ({ launchApp }) => {
  const { window, home } = await launchApp({ configured: true, withRepo: true, sessions: [{
    id: "obsidian-preview", repo: "widget", branch: "notes", title: "Vault preview", status: "idle",
    diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "2026-10-07T00:00:00.000Z"
  }] })
  const vaultPath = join(home, "vault")
  await mkdir(vaultPath)
  const vault = await realpath(vaultPath)
  await writeFile(join(vault, "one.md"), "# First note\n\n**Rendered Markdown**")
  await writeFile(join(vault, "two.md"), "# Second note")
  await writeFile(join(vault, "ignored.txt"), "not a note")
  await window.getByTestId("session-row-obsidian-preview").click()
  await window.getByRole("button", { name: "Obsidian", exact: true }).click()
  await window.getByLabel("Vault path").fill("relative")
  await window.getByRole("button", { name: "Save vault" }).click()
  await expect(window.getByRole("alert")).toContainText("absolute")
  await window.getByLabel("Vault path").fill(vault)
  await window.getByRole("button", { name: "Save vault" }).click()
  const preview = window.getByTestId("obsidian-preview")
  await expect(preview.getByRole("heading", { name: "First note" })).toBeVisible()
  await expect(preview.locator("strong")).toHaveText("Rendered Markdown")
  await expect(window.getByRole("navigation", { name: "Vault notes" })).not.toContainText("ignored.txt")
  await expect(preview.locator("textarea, input, [contenteditable=true]")).toHaveCount(0)
  await window.getByRole("button", { name: "two.md", exact: true }).click()
  await expect(preview.getByRole("heading", { name: "Second note" })).toBeVisible()
  await writeFile(join(vault, "two.md"), "# Updated externally")
  await window.getByRole("button", { name: "Refresh notes" }).click()
  await expect(preview.getByRole("heading", { name: "Updated externally" })).toBeVisible()
  await window.reload()
  await window.getByTestId("session-row-obsidian-preview").click()
  await window.getByRole("button", { name: "Obsidian", exact: true }).click()
  await expect(window.getByLabel("Vault path")).toHaveValue(vault)
  await expect(preview.getByRole("heading", { name: "First note" })).toBeVisible()
})

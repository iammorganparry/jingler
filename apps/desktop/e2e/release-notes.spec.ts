import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const LAST_RUN_VERSION_KEY = "jingler.last-run-version"
/** Changesets prefixes each CHANGELOG entry with its commit: `- c2a2490: …`. */
const COMMIT_PREFIX = /^[0-9a-f]{7,40}: /
const desktopRoot = join(import.meta.dirname, "..")
const appVersion = (JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  version: string
}).version

/** The first change the CHANGELOG records for the running version. */
const firstNoteFor = (version: string): string => {
  const changelog = readFileSync(join(desktopRoot, "CHANGELOG.md"), "utf8")
  const section = changelog.split(`## ${version}`)[1] ?? ""
  const bullet = section.split("\n").find((line) => line.startsWith("- "))
  if (bullet === undefined) throw new Error(`CHANGELOG has no entry for ${version}`)
  return bullet.slice(2).replace(COMMIT_PREFIX, "").trim()
}

test("relaunching on a newer version announces what changed, once", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true })
  await expect(appShell(window)).toBeVisible()
  const card = window.getByRole("region", { name: `Updated to Jingler ${appVersion}` })

  // A fresh install records its version and announces nothing.
  await expect(card).toHaveCount(0)
  expect(await window.evaluate((key) => localStorage.getItem(key), LAST_RUN_VERSION_KEY)).toBe(
    appVersion
  )

  // The last run was an older version: relaunching is what an update looks like.
  await window.evaluate((key) => localStorage.setItem(key, "0.0.1"), LAST_RUN_VERSION_KEY)
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  await expect(card).toBeVisible()
  await expect(card).toContainText(firstNoteFor(appVersion))

  // Dismissed, it stays gone across the next launch.
  await card.getByRole("button", { name: `Dismiss Jingler ${appVersion} release notes` }).click()
  await expect(card).toHaveCount(0)
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  await expect(card).toHaveCount(0)
})

test("What's new reopens from the account menu after dismissal", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true })
  await expect(appShell(window)).toBeVisible()
  await window.evaluate((key) => localStorage.setItem(key, "0.0.1"), LAST_RUN_VERSION_KEY)
  await window.reload()
  await expect(appShell(window)).toBeVisible()
  const card = window.getByRole("region", { name: `Updated to Jingler ${appVersion}` })
  await card.getByRole("button", { name: `Dismiss Jingler ${appVersion} release notes` }).click()
  await expect(card).toHaveCount(0)

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /^What's new \(v\d/ }).click()
  const dialog = window.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(`v${appVersion}`)
  await expect(dialog).toContainText(firstNoteFor(appVersion))
})

test("restarting to update asks first while an agent is running", async ({ launchApp }) => {
  const { app, window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      {
        id: "s_update",
        repo: "widget",
        branch: "main",
        title: "Update guard",
        status: "idle",
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-08-07T12:00:00.000Z",
        worktreePath: repoPath,
        mode: "accept-edits"
      }
    ]
  })
  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1500, height: 860 })
  // The updater only runs in packaged builds; publish its states from main the way it does.
  const publish = (state: object) =>
    app.evaluate(({ BrowserWindow }, next) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("jingler/update-state", next)
    }, state)
  const row = window.getByRole("region", { name: "Jingler update" })

  await publish({ status: "available", version: "9.9.9" })
  await expect(row).toContainText("v9.9.9 available")
  await expect(row.getByRole("button", { name: "Download" })).toBeVisible()
  await publish({ status: "downloading", version: "9.9.9", percent: 42 })
  await expect(row).toContainText("Downloading 42%")
  await publish({ status: "available", version: "9.9.9", error: "Download failed. Try again." })
  await expect(row).toContainText("Update failed")
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible()
  await publish({ status: "available", version: "9.9.9", manual: true })
  await expect(row.getByRole("button", { name: "Open installer" })).toBeVisible()
  await publish({ status: "downloaded", version: "9.9.9" })

  // Nothing running: no confirm to dismiss.
  const restart = row.getByRole("button", { name: "Restart to update" })
  await expect(restart).toBeVisible()

  // An agent mid-run turns the restart into a confirm.
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] keep this agent running")
  await composer.press("Enter")
  await expect(window.getByText("Holding the active turn for queue actions.")).toBeVisible({
    timeout: 15_000
  })
  await restart.click()
  const dialog = window.getByRole("dialog")
  await expect(dialog).toContainText("1 agent is running. Restarting stops it.")
  await dialog.getByRole("button", { name: "Wait" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(restart).toBeVisible()
})

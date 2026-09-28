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

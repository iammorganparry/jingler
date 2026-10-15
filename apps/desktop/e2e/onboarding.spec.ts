import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type LaunchedApp } from "./fixtures.js"

const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: dir })
}

const pickFolder = (launched: LaunchedApp, folder: string) =>
  launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, folder)

test("onboarding step 1 registers exactly the ticked repositories", async ({ launchApp }) => {
  const launched = await launchApp({
    seed: ({ reposDir }) => {
      initRepo(join(reposDir, "alpha"))
      initRepo(join(reposDir, "beta"))
      initRepo(join(reposDir, "gamma"))
    }
  })
  const { window } = launched
  await pickFolder(launched, launched.reposDir)
  await window.getByRole("button", { name: "Choose repos folder" }).click()

  const current = window.getByRole("list", { name: "Progress" }).locator("[aria-current=step]")
  await expect(current).toContainText("Projects folder")
  await window.getByRole("checkbox", { name: "alpha" }).click()
  await window.getByRole("checkbox", { name: "gamma" }).click()
  await window.getByRole("button", { name: "Add 2 projects" }).click()

  await expect(window.getByRole("heading", { name: "Connect GitHub" })).toBeVisible()
  const projects = JSON.parse(readFileSync(join(launched.home, "jingler", "projects.json"), "utf8")) as Array<{ name: string }>
  expect(projects.map(({ name }) => name).sort()).toEqual(["alpha", "gamma"])
})

test("a failed folder scan keeps onboarding on step 1 with the inline error", async ({ launchApp }) => {
  const launched = await launchApp()
  const { window } = launched
  const locked = join(mkdtempSync(join(tmpdir(), "jingler-e2e-locked-")), "not-a-folder")
  writeFileSync(locked, "")
  try {
    await pickFolder(launched, locked)
    await window.getByRole("button", { name: "Choose repos folder" }).click()

    await expect(window.getByRole("alert")).toContainText(`Couldn't read ${locked}`)
    await expect(window.getByRole("heading", { name: "Set up your workspace" })).toBeVisible()
    await expect(window.getByRole("button", { name: "Choose another folder" })).toBeVisible()
  } finally {
    rmSync(locked, { force: true })
  }
})

test("an empty folder shows the empty state with Clone a repository", async ({ launchApp }) => {
  const launched = await launchApp()
  const { window } = launched
  await pickFolder(launched, launched.reposDir)
  await window.getByRole("button", { name: "Choose repos folder" }).click()

  await expect(window.getByText(`No git repositories in ${launched.reposDir}`)).toBeVisible()
  await expect(window.getByRole("button", { name: "Clone a repository" })).toBeVisible()
})

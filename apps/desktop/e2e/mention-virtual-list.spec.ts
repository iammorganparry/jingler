import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const FILE_COUNT = 200

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_mention_list",
    repo: "widget",
    branch: "main",
    title: "Mention list",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("the @ mention list is windowed and driven by the keyboard", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src"), { recursive: true })
      for (let i = 0; i < FILE_COUNT; i++) {
        writeFileSync(join(repoPath, "src", `module-${String(i).padStart(3, "0")}.ts`), "export {}\n")
      }
    }
  })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.click()
  await composer.pressSequentially("@module")

  const list = window.getByRole("listbox", { name: "Files" })
  await expect(list).toBeVisible()
  const rows = list.getByRole("option")
  // Windowed: far fewer rows are mounted than files match.
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeLessThan(FILE_COUNT / 2)
  const active = list.getByRole("option", { selected: true })
  await expect(active).toContainText("module-000.ts")

  // Arrow keys move the active row and scroll it into view.
  for (let i = 0; i < 40; i++) await composer.press("ArrowDown")
  await expect(active).toContainText("module-040.ts")
  await expect(active).toBeInViewport()
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

  // Enter inserts the active file as a mention.
  await composer.press("Enter")
  await expect(composer).toHaveValue(/@src\/module-040\.ts/)
  await expect(list).toHaveCount(0)
})

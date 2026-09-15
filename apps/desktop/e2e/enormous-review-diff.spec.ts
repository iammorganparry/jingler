import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const SESSION_ID = "s_enormous_review_diff"
/** Five times the per-file review limit — the shape of a generated changeset. */
const GENERATED_LINES = 100_000

const session = ({ repoPath }: { readonly repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: SESSION_ID,
  repo: "widget",
  branch: "jingler/enormous-diff",
  title: "Enormous review diff",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-09-15T12:00:00.000Z",
  worktreePath: repoPath
}]

test("the Changes review stays responsive when one file's diff is enormous", async ({ launchApp }) => {
  test.setTimeout(120_000)
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session,
    seed: ({ repoPath }) => {
      execFileSync("git", ["checkout", "-b", "jingler/enormous-diff"], { cwd: repoPath })
      const src = join(repoPath, "src")
      mkdirSync(src, { recursive: true })
      writeFileSync(join(src, "edit.ts"), "export const mode = 'old'\n")
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "seed", "--no-gpg-sign"], { cwd: repoPath })
      // One ordinary edit the reviewer must still see, next to a generated file
      // whose diff would have taken the renderer's V8 heap to its limit.
      writeFileSync(join(src, "edit.ts"), "export const mode = 'new'\n")
      writeFileSync(join(repoPath, "generated.txt"), "generated line\n".repeat(GENERATED_LINES))
    }
  })

  await expect(appShell(window)).toBeVisible()
  const skipImport = window.getByRole("button", { name: "Skip import" })
  if (await skipImport.isVisible()) await skipImport.click()
  const terminalClose = window.getByRole("button", { name: "Close zsh" })
  if (await terminalClose.isVisible()) await terminalClose.click()
  await sessionRow(window, "Enormous review diff").click()

  await window.getByRole("button", { name: "Changes" }).first().click()
  const region = window.getByRole("region", { name: "Code review changes" })
  await expect(region).toBeVisible({ timeout: 30_000 })

  // The generated file is listed with its real size, and named as omitted…
  const omitted = window.getByTestId("review-omitted-files")
  await expect(omitted).toBeVisible({ timeout: 30_000 })
  await expect(omitted).toContainText("generated.txt")
  await expect(omitted).toContainText("+100,000")
  await expect(omitted).toContainText("20,000")

  // …while the ordinary edit still renders as a real diff.
  await expect(region.locator('[data-line-type="change-addition"]').first()).toBeVisible({
    timeout: 30_000
  })
  await expect(region).toContainText("mode = 'new'")

  // The renderer never held the 100k-line patch: the JS heap stays far under
  // the size that patch alone would have cost.
  const heapBytes = await window.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
  )
  expect(heapBytes).toBeLessThan(1_000_000_000)
})

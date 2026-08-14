import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const SESSION_ID = "s_canonical_changes"

const session = ({ repoPath }: { readonly repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: SESSION_ID,
  repo: "widget",
  branch: "jingler/canonical-changes",
  title: "Canonical file changes",
  status: "idle",
  diff: { added: 3, removed: 2 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T12:00:00.000Z",
  worktreePath: repoPath
}]

const changes = [
  { status: "A", path: "src/new.ts", oldPath: null, added: 1, removed: 0, binary: false, noNewlineAtEnd: false, beforeBytes: 0, afterBytes: 24, preview: "+export const created = true", patchArtifactId: "patch-a" },
  { status: "M", path: "src/edit.ts", oldPath: null, added: 1, removed: 1, binary: false, noNewlineAtEnd: false, beforeBytes: 25, afterBytes: 25, preview: "-export const mode = 'old'\n+export const mode = 'new'", patchArtifactId: "patch-m" },
  { status: "D", path: "src/gone.ts", oldPath: null, added: 0, removed: 1, binary: false, noNewlineAtEnd: false, beforeBytes: 25, afterBytes: 0, preview: "-export const gone = true", patchArtifactId: "patch-d" },
  { status: "R", path: "src/after.ts", oldPath: "src/before.ts", added: 0, removed: 0, binary: false, noNewlineAtEnd: false, beforeBytes: 26, afterBytes: 26, preview: null, patchArtifactId: "patch-r" }
] as const

const transcript = [{
  id: "a_changes",
  role: "assistant",
  streaming: false,
  createdAt: "2026-08-10T12:00:00.000Z",
  parts: [{
    _tag: "Tool",
    tool: {
      id: "tool_changes",
      name: "Workspace changes",
      target: null,
      status: "success",
      meta: "Final workspace reconciliation",
      diff: { added: 3, removed: 2 },
      preview: changes[0].preview,
      fileChanges: {
        id: "changes-1",
        callId: "tool_changes",
        changes,
        totals: { added: 3, removed: 2 },
        authoritative: true,
        reconciledAt: "2026-08-10T12:00:00.000Z"
      }
    }
  }]
}]

test("renders canonical create, modify, delete, and rename evidence across chat and Changes", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session,
    transcripts: { [SESSION_ID]: transcript },
    seed: ({ repoPath }) => {
      execFileSync("git", ["checkout", "-b", "jingler/canonical-changes"], {
        cwd: repoPath
      })
      const src = join(repoPath, "src")
      mkdirSync(src, { recursive: true })
      writeFileSync(join(src, "edit.ts"), "export const mode = 'old'\n")
      writeFileSync(join(src, "gone.ts"), "export const gone = true\n")
      writeFileSync(join(src, "before.ts"), "export const stable = true\n")
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "seed changes", "--no-gpg-sign"], {
        cwd: repoPath
      })
      writeFileSync(join(src, "new.ts"), "export const created = true\n")
      writeFileSync(join(src, "edit.ts"), "export const mode = 'new'\n")
      rmSync(join(src, "gone.ts"))
      renameSync(join(src, "before.ts"), join(src, "after.ts"))
    }
  })

  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "Canonical file changes").click()
  const terminalClose = window.getByRole("button", { name: "Close zsh" })
  if (await terminalClose.isVisible()) {
    await terminalClose.click()
  }
  await expect(window.locator('[data-file-change="A"]')).toContainText("src/new.ts")
  await expect(window.locator('[data-file-change="M"]')).toContainText("src/edit.ts")
  await expect(window.locator('[data-file-change="D"]')).toContainText("src/gone.ts")
  await expect(window.locator('[data-file-change="R"]')).toContainText("src/before.ts")
  await expect(window.locator('[data-file-change="R"]')).toContainText("src/after.ts")

  await window.getByRole("button", { name: "Changes" }).first().click()
  await expect(window.getByRole("region", { name: "Code review changes" })).toBeVisible({
    timeout: 30_000
  })
  const rail = window.getByTestId("review-file-rail")
  if (!(await rail.isVisible())) {
    await window.getByRole("button", { name: "Changed files" }).click()
  }
  await expect(rail).toBeVisible()
  const tree = rail.locator('[aria-label="Changed files tree"]')
  await expect(tree.locator('[data-item-path="src/new.ts"]')).toHaveAttribute(
    "data-item-git-status",
    "added"
  )
  await expect(tree.locator('[data-item-path="src/edit.ts"]')).toHaveAttribute(
    "data-item-git-status",
    "modified"
  )
  await expect(tree.locator('[data-item-path="src/gone.ts"]')).toHaveAttribute(
    "data-item-git-status",
    "deleted"
  )
  await expect(tree.locator('[data-item-path="src/after.ts"]')).toHaveAttribute(
    "data-item-git-status",
    "renamed"
  )
})

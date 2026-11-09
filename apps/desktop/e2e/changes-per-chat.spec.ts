import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const SESSION_ID = "s_per_chat_changes"
const AT = "2026-11-09T12:00:00.000Z"

const session = ({ repoPath }: { readonly repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: SESSION_ID,
  repo: "widget",
  branch: "jingler/per-chat-changes",
  title: "Per-chat changes",
  status: "idle",
  diff: { added: 2, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: AT,
  worktreePath: repoPath,
  chats: [
    { id: "c_alpha", title: "Alpha", createdAt: AT, updatedAt: AT },
    { id: "c_beta", title: "Beta", createdAt: AT, updatedAt: AT }
  ],
  activeChatId: "c_alpha"
}]

/** One assistant turn whose edit tool changed `path`. */
const editTurn = (id: string, path: string) => [{
  id,
  role: "assistant",
  streaming: false,
  createdAt: AT,
  parts: [{
    _tag: "Tool",
    tool: {
      id: `tool-${id}`,
      name: "Edit",
      target: path,
      status: "success",
      meta: null,
      diff: { added: 1, removed: 0 },
      preview: null,
      fileChanges: {
        id: `changes-${id}`,
        callId: `tool-${id}`,
        changes: [{ status: "A", path, oldPath: null, added: 1, removed: 0, binary: false, noNewlineAtEnd: false, beforeBytes: 0, afterBytes: 20, preview: null, patchArtifactId: null }],
        totals: { added: 1, removed: 0 },
        authoritative: true,
        reconciledAt: AT
      }
    }
  }]
}]

test("each chat in a session opens Changes scoped to the files it touched", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session,
    transcripts: { c_alpha: editTurn("a_alpha", "src/alpha.ts"), c_beta: editTurn("a_beta", "src/beta.ts") },
    seed: ({ repoPath }) => {
      execFileSync("git", ["checkout", "-b", "jingler/per-chat-changes"], { cwd: repoPath })
      mkdirSync(join(repoPath, "src"), { recursive: true })
      writeFileSync(join(repoPath, "src", "alpha.ts"), "export const a = 1\n")
      writeFileSync(join(repoPath, "src", "beta.ts"), "export const b = 1\n")
    }
  })

  await expect(appShell(window)).toBeVisible()
  const skipImport = window.getByRole("button", { name: "Skip import" })
  if (await skipImport.isVisible()) await skipImport.click()
  await sessionRow(window, "Per-chat changes").click()
  await window.getByRole("button", { name: /^Changes\b/ }).last().click()

  const rail = window.getByTestId("changed-files-explorer")
  await expect(rail).toBeVisible({ timeout: 30_000 })
  const tree = rail.locator('[aria-label="Changed files tree"]')
  const alpha = tree.locator('[data-item-path="src/alpha.ts"]')
  const beta = tree.locator('[data-item-path="src/beta.ts"]')

  await expect(rail.getByRole("tab", { name: "This chat" })).toHaveAttribute("aria-selected", "true")
  await expect(alpha).toBeVisible()
  await expect(beta).toHaveCount(0)

  await rail.getByRole("tab", { name: "All chats" }).click()
  await expect(alpha).toBeVisible()
  await expect(beta).toBeVisible()

  // The session tree lives on the Sessions tab; its row name leads with a status dot ("Idle Beta").
  await window.getByRole("tab", { name: "Sessions" }).click()
  await window.getByTestId(`session-tree-${SESSION_ID}`).getByRole("button", { name: /^(Idle|Running) Beta$/ }).click()
  await expect(window.getByTestId("thread-switcher")).toContainText("Beta")
  await window.getByRole("tab", { name: "Explorer" }).click()
  await expect(rail.getByRole("tab", { name: "This chat" })).toHaveAttribute("aria-selected", "true")
  await expect(beta).toBeVisible()
  await expect(alpha).toHaveCount(0)
})

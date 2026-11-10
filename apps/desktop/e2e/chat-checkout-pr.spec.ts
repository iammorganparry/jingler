import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const SESSION_ID = "s_chat_checkout_pr"
const AT = "2026-11-10T12:00:00.000Z"

const session = ({ repoPath }: { readonly repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: SESSION_ID,
  repo: "widget",
  branch: "fix/alpha",
  title: "Per-chat PRs",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: 997,
  costUsd: 0,
  tokens: 0,
  updatedAt: AT,
  worktreePath: repoPath,
  checkouts: [
    { id: "primary", repo: "widget", branch: "fix/alpha", prNumber: 997, worktreePath: repoPath },
    { id: "co_beta", repo: "widget", branch: "feat/beta", prNumber: 998, worktreePath: repoPath }
  ],
  activeCheckoutId: "primary",
  chats: [
    { id: "c_alpha", title: "Alpha", checkoutId: "primary", createdAt: AT, updatedAt: AT },
    { id: "c_beta", title: "Beta", checkoutId: "co_beta", createdAt: AT, updatedAt: AT }
  ],
  activeChatId: "c_alpha"
}]

test("switching chats switches the header PR to that chat's own checkout", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: session })

  await expect(appShell(window)).toBeVisible()
  const skipImport = window.getByRole("button", { name: "Skip import" })
  if (await skipImport.isVisible()) await skipImport.click()
  await sessionRow(window, "Per-chat PRs").click()

  const chip = window.getByTestId("header-link-pr")
  await expect(chip).toHaveText("PR #997")

  const tree = window.getByTestId(`session-tree-${SESSION_ID}`)
  await tree.getByRole("button", { name: /^(Idle|Running) Beta$/ }).click()
  await expect(window.getByTestId("thread-switcher")).toContainText("Beta")
  await expect(chip).toHaveText("PR #998")

  await tree.getByRole("button", { name: /^(Idle|Running) Alpha$/ }).click()
  await expect(chip).toHaveText("PR #997")
  await chip.click()
  await expect(window.getByTestId("editor-tab-view-checks")).toHaveCount(1)
})

import { writeFile } from "node:fs/promises"
import { expect, sessionRow, test } from "./fixtures.js"

test("switch sessions with PR view and a running reviewer visible", async ({ launchApp }, testInfo) => {
  test.setTimeout(180_000)
  const { window } = await launchApp({
    configured: true, withRepo: true,
    sessions: ({ repoPath }) => ["review", "other"].map((id) => ({
      id: `s_${id}`, repo: "widget", branch: "chore/refactor",
      title: `${id} session`, status: "idle" as const, diff: { added: 10, removed: 0 },
      prNumber: id === "review" ? 482 : null, costUsd: 0, tokens: 0,
      updatedAt: "2026-07-24T10:00:00.000Z", worktreePath: repoPath
    })),
    githubApp: {
      connected: true, userLogin: "e2e-user",
      prs: [{ number: 482, title: "Review switch stress", headRefName: "chore/refactor", baseRefName: "main", author: { login: "octocat" }, state: "OPEN",
        body: ("## Review context\n\nRich PR content with **formatting** and `inline code`.\n\n").repeat(60) }],
      diff: "diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -0,0 +1 @@\n+// [[review-switch-stress]]\n"
    }
  })
  await window.evaluate(() => localStorage.setItem("jingler:mcp-import-prompt:v1", "done"))
  await window.reload()
  await sessionRow(window, "review session").click()
  await window.getByRole("button", { name: "Pull Request", exact: true }).click()
  await window.getByRole("button", { name: /Adversarial review/ }).click()
  const running = window.getByRole("button", { name: /Reading the code…|Thinking…|Writing findings…/ })
  await expect(running).toBeVisible({ timeout: 20_000 })
  await window.getByRole("button", { name: /Reviewer/ }).click()
  await expect(window.getByRole("textbox", { name: "Inline agents are watch-only — steer them through the main chat." })).toBeVisible()
  await expect(running).toBeVisible()

  const cdp = await window.context().newCDPSession(window)
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.start")
  const durations: number[] = []
  try {
    for (let i = 0; i < 12; i++) {
      const start = Date.now()
      await sessionRow(window, "other session").click({ timeout: 5_000 })
      await expect(window.locator('[data-session="s_other"]:visible')).toHaveCount(1, { timeout: 5_000 })
      await sessionRow(window, "review session").click({ timeout: 5_000 })
      await expect(running).toBeVisible({ timeout: 5_000 })
      await expect(window.getByRole("textbox", { name: "Inline agents are watch-only — steer them through the main chat." })).toBeVisible({ timeout: 5_000 })
      durations.push(Date.now() - start)
    }
  } finally {
    const { profile } = await cdp.send("Profiler.stop")
    const path = testInfo.outputPath("pr-review-session-switch.cpuprofile")
    await writeFile(path, JSON.stringify(profile))
    await testInfo.attach("pr-review-session-switch.cpuprofile", { path, contentType: "application/json" })
    await cdp.detach()
    console.log(`PR_REVIEW_SESSION_SWITCH ${JSON.stringify({ roundTripsMs: durations })}`)
  }
})

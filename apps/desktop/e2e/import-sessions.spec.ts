import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

test("imports a Claude Code session from disk", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home, repoPath }) => {
      // Seed a fake Claude Code session JSONL file
      const claudeDir = join(home, ".claude", "projects", "test-repo")
      mkdirSync(claudeDir, { recursive: true })
      
      const sessionFile = join(claudeDir, "session_abc123.jsonl")
      const lines = [
        JSON.stringify({
          type: "user",
          sessionId: "abc123",
          cwd: repoPath,
          gitBranch: "main",
          timestamp: "2026-10-01T12:00:00.000Z",
          message: { content: "Fix the login bug" }
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-10-01T12:01:00.000Z"
        }),
        JSON.stringify({
          type: "user",
          sessionId: "abc123",
          cwd: repoPath,
          gitBranch: "main",
          timestamp: "2026-10-02T14:00:00.000Z",
          message: { content: "Add tests" }
        })
      ]
      writeFileSync(sessionFile, lines.join("\n"))
    }
  })

  await expect(appShell(launched.window)).toBeVisible()

  // Click "Import sessions…" button in the sidebar
  const importButton = launched.window.getByRole("button", { name: "Import sessions…" })
  await importButton.click()

  // Wait for the dialog to appear and scan to complete
  const dialog = launched.window.getByRole("dialog")
  await expect(dialog).toBeVisible()

  // The seeded session should be listed
  await expect(dialog.getByText("Fix the login bug")).toBeVisible({ timeout: 10_000 })

  // Select the session by clicking its checkbox
  const checkbox = dialog.getByRole("checkbox", { name: /Select Fix the login bug/ })
  await checkbox.check()

  // Click the Import button
  const importActionButton = dialog.getByRole("button", { name: /Import 1 session/ })
  await importActionButton.click()

  // Wait for the dialog to close (signals import completed)
  await expect(dialog).toHaveCount(0, { timeout: 15_000 })

  // Verify the session was imported to sessions.json
  const sessionsPath = join(launched.home, "jingler", "sessions.json")
  await expect.poll(() => existsSync(sessionsPath)).toBe(true)
  
  const persisted = JSON.parse(readFileSync(sessionsPath, "utf8"))
  const imported = persisted.find((s: any) => s.title === "Fix the login bug")
  expect(imported).toBeDefined()
  expect(imported.repo).toBe("widget")
  expect(imported.importedFrom).toMatchObject({
    source: "claude-code",
    nativeSessionId: "abc123"
  })
})

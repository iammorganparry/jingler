import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, showSessions, test } from "./fixtures.js"

test("approves setup, copied files, named Run/Stop, and archive cleanup", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true, withRepo: true })
  const { window, repoPath, home } = launched
  await expect(appShell(window)).toBeVisible()
  appendFileSync(join(repoPath, ".gitignore"), "\n.env.local\n")
  writeFileSync(join(repoPath, ".env.local"), "WORKFLOW_COPY=ready\n")

  await window.getByTestId("new-session").click()
  await addProject(window, repoPath)
  await window.keyboard.press("Escape")

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects" }).click()
  await window.getByLabel("Setup command").fill("node -e \"require('node:fs').writeFileSync('setup-proof.txt','ready')\"")
  await window.getByRole("button", { name: "Add run command" }).click()
  await window.getByLabel("Run name 1", { exact: true }).fill("Dev")
  await window.getByLabel("Run command 1", { exact: true }).fill("node -e \"setInterval(()=>{},1000)\"")
  await window.getByLabel("Cleanup command").fill("node -e \"require('node:fs').writeFileSync('cleanup-proof.txt','done')\"")
  await window.getByLabel("Copied files").fill(".env.local")
  await window.getByRole("checkbox", { name: /I approve these commands/ }).click()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()

  await window.getByTestId("new-session").click()
  await window.getByRole("button", { name: "Create workspace" }).click()
  await expect(window.getByTestId("workspace-workflow-bar")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("button", { name: "Run Dev" })).toBeVisible()

  const sessionsPath = join(home, "jingler", "sessions.json")
  await expect.poll(() => existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, "utf8"))[0]?.worktreePath : null).not.toBeNull()
  const session = JSON.parse(readFileSync(sessionsPath, "utf8"))[0] as { id: string; worktreePath: string }
  expect(readFileSync(join(session.worktreePath, "setup-proof.txt"), "utf8")).toBe("ready")
  expect(readFileSync(join(session.worktreePath, ".env.local"), "utf8")).toContain("WORKFLOW_COPY=ready")

  await window.getByRole("button", { name: "Run Dev" }).click()
  await expect(window.getByRole("button", { name: "Stop Dev" })).toBeVisible()
  // Remove a live definition: its original label and Stop control must survive.
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects" }).click()
  await window.getByRole("button", { name: "Remove run command 1" }).click()
  await window.getByRole("button", { name: "Add run command" }).click()
  await window.getByLabel("Run name 1", { exact: true }).fill("Broken line")
  await window.getByRole("checkbox", { name: /I approve these commands/ }).click()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText(/Run command row 1 needs/)).toBeVisible()
  await window.getByLabel("Run name 1", { exact: true }).fill("Fail")
  await window.getByLabel("Run command 1", { exact: true }).fill("node -e \"console.error('named failure proof');process.exit(7)\"")
  await window.getByRole("checkbox", { name: /I approve these commands/ }).click()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()
  await expect(window.getByRole("button", { name: "Stop Dev" })).toBeVisible()
  await window.getByRole("button", { name: "Stop Dev" }).click()
  await expect(window.getByRole("button", { name: "Stop Dev" })).not.toBeVisible({ timeout: 10_000 })
  await window.getByRole("button", { name: "Run Fail" }).click()
  await expect(window.getByText("Fail failed (exit 7)", { exact: true })).toBeVisible({ timeout: 10_000 })
  await window.getByText("Fail failed (exit 7)", { exact: true }).click()
  await expect(window.getByTestId("workspace-workflow-bar").getByText("named failure proof", { exact: true })).toBeVisible()

  const row = window.locator("[data-testid^='session-row-']").first()
  await row.hover()
  await row.getByRole("button", { name: /^Archive / }).click()
  await expect.poll(() => existsSync(join(session.worktreePath, "cleanup-proof.txt"))).toBe(true)
  await expect.poll(() => JSON.parse(readFileSync(sessionsPath, "utf8")).find((item: { id: string }) => item.id === session.id)?.archived).toBe(true)
})

for (const recovery of ["retry", "skip"] as const) {
  test(`failed setup and cleanup block work; explicit ${recovery} recovers without replay on Restore`, async ({ launchApp }) => {
    test.setTimeout(90000)
    const { window, repoPath, home } = await launchApp({ configured: true, withRepo: true, piFixture: { scenarioId: "workspace-workflow", authRoute: "api-key" } })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("new-session").click(); await addProject(window, repoPath); await window.keyboard.press("Escape")
    await window.getByRole("button", { name: "Account menu" }).click()
    await window.getByRole("menuitem", { name: "Settings" }).click()
    await window.getByRole("button", { name: "Projects", exact: true }).click()
    // Each invocation leaves evidence, even the failed first attempt.
    for (const phase of ["setup", "cleanup"] as const) {
      await window.getByLabel(`${phase === "setup" ? "Setup" : "Cleanup"} command`).fill(`node -e "const fs=require('node:fs');fs.appendFileSync('${phase}-attempts','x');if(!fs.existsSync('allow-${phase}'))process.exit(7)"`)
    }
    await window.getByRole("button", { name: "Add run command" }).click()
    await window.getByLabel("Run name 1", { exact: true }).fill("Proof")
    await window.getByLabel("Run command 1", { exact: true }).fill("node -e \"require('node:fs').writeFileSync('run-proof','ran')\"")
    await window.getByRole("checkbox", { name: /I approve these commands/ }).click()
    await window.getByRole("button", { name: "Save workflow" }).click()
    await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
    await window.getByRole("button", { name: "Close settings" }).click()
    await window.getByTestId("new-session").click()
    await window.getByRole("button", { name: "Create workspace" }).click()
    const bar = window.getByTestId("workspace-workflow-bar")
    await expect(bar.getByRole("alert")).toContainText("Setup failed", { timeout: 20000 })
    const sessions = () => JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
    const session = sessions()[0]
    const cwd = session.worktreePath
    const current = () => sessions().find((item: { id: string }) => item.id === session.id)
    expect(readFileSync(join(cwd, "setup-attempts"), "utf8")).toBe("x")
    await expect(window.getByRole("button", { name: "Run Proof" })).toHaveCount(0)
    const composer = window.getByPlaceholder("Message the agent…")
    await composer.fill("Blocked workflow turn"); await composer.press("Enter")
    await expect(window.getByText("Workspace setup failed. Retry or explicitly skip setup before sending a message.", { exact: true })).toBeVisible()
    await expect(window.getByText("Workflow turn admitted.", { exact: true })).toHaveCount(0)
    expect(existsSync(join(cwd, "run-proof"))).toBe(false)
    if (recovery === "retry") writeFileSync(join(cwd, "allow-setup"), "approved retry")
    await bar.getByRole("button", { name: recovery === "retry" ? "Retry setup" : "Skip setup", exact: true }).click()
    await expect.poll(() => current().workspaceLifecycle.status).toBe(recovery === "retry" ? "ready" : "setup-skipped")
    expect(readFileSync(join(cwd, "setup-attempts"), "utf8")).toBe(recovery === "retry" ? "xx" : "x")
    await window.getByRole("button", { name: "Run Proof" }).click()
    await expect.poll(() => existsSync(join(cwd, "run-proof"))).toBe(true)
    await expect(window.getByRole("button", { name: "Stop Proof" })).toHaveCount(0)
    await composer.fill("Recovered workflow turn"); await composer.press("Enter")
    await expect(window.getByText("Workflow turn admitted.", { exact: true })).toBeVisible()
    const row = window.getByTestId(`session-row-${session.id}`)
    await row.hover(); await row.getByRole("button", { name: /^Archive / }).click()
    await expect(window.getByRole("dialog", { name: "Archive failed" })).toContainText("Cleanup exited with code 7.")
    expect(current().workspaceLifecycle.status).toBe("cleanup-failed")
    expect(current().archived).not.toBe(true)
    expect(readFileSync(join(cwd, "cleanup-attempts"), "utf8")).toBe("x")
    if (recovery === "retry") {
      writeFileSync(join(cwd, "allow-cleanup"), "approved retry")
      await window.getByRole("dialog").filter({ hasText: "Archive failed" }).getByRole("button", { name: "Retry", exact: true }).click()
    } else {
      await window.getByRole("dialog").filter({ hasText: "Archive failed" }).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(bar.getByRole("alert").filter({ hasText: "Cleanup failed" })).toBeVisible()
      await bar.getByRole("button", { name: "Archive without cleanup", exact: true }).click()
    }
    await expect.poll(() => current().archived).toBe(true)
    const setupAttempts = readFileSync(join(cwd, "setup-attempts"), "utf8")
    const cleanupAttempts = readFileSync(join(cwd, "cleanup-attempts"), "utf8")
    expect(cleanupAttempts).toBe(recovery === "retry" ? "xx" : "x")
    await showSessions(window, "Archived")
    const archivedRow = window.getByTestId(`session-row-${session.id}`)
    await archivedRow.hover(); await archivedRow.getByRole("button", { name: /^Restore / }).click()
    await expect.poll(() => current().archived).toBe(false)
    await expect(composer).toBeVisible()
    // Observe a bounded interval after restore to catch asynchronous hook replay.
    const settledAt = Date.now() + 1500
    await expect.poll(() => {
      expect(readFileSync(join(cwd, "setup-attempts"), "utf8")).toBe(setupAttempts)
      expect(readFileSync(join(cwd, "cleanup-attempts"), "utf8")).toBe(cleanupAttempts)
      return Date.now()
    }).toBeGreaterThan(settledAt)
  })
}

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, showSessions, test } from "./fixtures.js"

test("warned ordinary-terminal archive preserves files and never runs cleanup", async ({ launchApp }) => {
  const { window, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click(); await addProject(window, repoPath); await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects", exact: true }).click()
  await window.getByLabel("Cleanup command").fill("node -e \"require('node:fs').writeFileSync('cleanup-proof.txt','unsafe')\"")
  await window.getByLabel(/approve/i).first().check()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await window.getByRole("button", { name: "Close settings" }).click()
  await window.getByTestId("new-session").click()
  await window.getByRole("button", { name: "Create workspace" }).click()
  await window.getByPlaceholder("Message the agent…").waitFor()
  const sessions = () => JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
  await window.keyboard.press("Control+Backquote")
  await expect.poll(() => sessions()[0]?.checkpointPtyHistory).toBe(true)
  const cwd = sessions()[0].worktreePath
  writeFileSync(join(cwd, "preserve-me"), "preserved")
  const pidPath = join(cwd, "terminal-job.pid")
  const heartbeatPath = join(cwd, "terminal-heartbeat")
  const stopPath = join(cwd, "stop-terminal-job")
  const donePath = join(cwd, "terminal-job-stopped")
  const scriptPath = join(cwd, "terminal-job.cjs")
  writeFileSync(scriptPath, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(stopPath)})) {
    fs.writeFileSync(${JSON.stringify(donePath)}, 'stopped');
    process.exit(0);
  }
  fs.appendFileSync(${JSON.stringify(heartbeatPath)}, '.');
}, 100);`)
  const heartbeat = () => existsSync(heartbeatPath) ? readFileSync(heartbeatPath).length : 0
  try {
    await window.getByRole("textbox", { name: "Terminal input" }).click()
    await window.keyboard.type(`"${process.execPath}" "${scriptPath}"`)
    await window.keyboard.press("Enter")
    await expect.poll(heartbeat).toBeGreaterThan(0)
    const beforeArchive = heartbeat()
    await expect.poll(heartbeat).toBeGreaterThan(beforeArchive)

    const row = window.locator("[data-testid^='session-row-']").first(); await row.hover()
    await row.getByRole("button", { name: /^Archive / }).click()
    const dialog = window.getByRole("dialog", { name: "Archive without cleanup?" })
    await expect(dialog).toContainText("running jobs are preserved")
    expect(sessions()[0].archived).not.toBe(true)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(sessions()[0].archived).not.toBe(true)
    expect(existsSync(join(cwd, "cleanup-proof.txt"))).toBe(false)
    await row.hover(); await row.getByRole("button", { name: /^Archive / }).click()
    await expect(dialog).toContainText("running jobs are preserved")
    await dialog.getByRole("button", { name: "Archive without cleanup", exact: true }).click()
    await expect.poll(() => sessions()[0].archived).toBe(true)
    const afterArchive = heartbeat()
    await expect.poll(heartbeat).toBeGreaterThan(afterArchive)
    expect(readFileSync(join(cwd, "preserve-me"), "utf8")).toBe("preserved")
    expect(existsSync(join(cwd, "cleanup-proof.txt"))).toBe(false)
    await showSessions(window, "Archived")
    const archivedRow = window.locator("[data-testid^='session-row-']").first()
    await archivedRow.hover()
    await archivedRow.getByRole("button", { name: /^Restore / }).click()
    await expect.poll(() => sessions()[0].archived).toBe(false)
    expect(sessions()[0].checkpointPtyHistory).toBe(true)
    expect(sessions()[0].checkpointExecutionHistory).toBe("unprovable")
    const afterRestore = heartbeat()
    await expect.poll(heartbeat).toBeGreaterThan(afterRestore)
    expect(readFileSync(join(cwd, "preserve-me"), "utf8")).toBe("preserved")
    expect(existsSync(join(cwd, "cleanup-proof.txt"))).toBe(false)
  } finally {
    // A file-based stop also catches a job that starts after an assertion fails.
    writeFileSync(stopPath, "stop")
    try {
      if (existsSync(pidPath)) await expect.poll(() => existsSync(donePath)).toBe(true)
    } finally {
      if (existsSync(pidPath) && !existsSync(donePath)) {
        try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL") }
        catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH") }
      }
    }
  }
})

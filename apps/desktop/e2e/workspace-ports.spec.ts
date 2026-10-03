import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("two isolated servers have distinct previews and stopping one preserves the other", async ({ launchApp }) => {
  const { window, app, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  writeFileSync(join(repoPath, "preview-server.cjs"), `const http = require('node:http'); http.createServer((req,res) => res.end(process.env.JINGLER_PORT + ':' + process.env.JINGLER_WORKSPACE_PATH)).listen(Number(process.env.JINGLER_PORT), '127.0.0.1');`)
  execFileSync("git", ["add", "preview-server.cjs"], { cwd: repoPath })
  execFileSync("git", ["commit", "-m", "add preview fixture"], { cwd: repoPath })
  await expect(appShell(window)).toBeVisible()
  await addProject(window, repoPath)
  await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects" }).click()
  await window.getByLabel("Run commands").fill("Dev=node preview-server.cjs")
  await window.getByLabel("Preview URL template").fill("http://127.0.0.1:{port}")
  await window.getByRole("checkbox").check()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()

  const readSessions = (): Array<{ id: string; worktreePath: string; workspacePorts: { primary: number } }> => JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))
  const created: Array<{ id: string; worktreePath: string; workspacePorts: { primary: number } }> = []
  for (let index = 0; index < 2; index++) {
    await window.getByTestId("new-session").click()
    await window.getByRole("button", { name: "Create workspace" }).click()
    await expect(window.getByRole("button", { name: "Run Dev" })).toBeVisible({ timeout: 20000 })
    const session = readSessions().find((item) => !created.some((previous) => previous.id === item.id))!
    created.push(session)
    await window.getByRole("button", { name: "Open preview", exact: true }).click()
    await expect(window.getByRole("alert").filter({ hasText: "Preview is not ready" })).toBeVisible()
    await window.getByRole("button", { name: "Run Dev" }).click()
    const url = `http://127.0.0.1:${session.workspacePorts.primary}/`
    await expect.poll(async () => { try { return await (await fetch(url)).text() } catch { return "" } }).toBe(`${session.workspacePorts.primary}:${session.worktreePath}`)
    await window.getByRole("button", { name: "Open preview", exact: true }).click()
    await expect.poll(() => app.evaluate(({ webContents }, expected) => webContents.getAllWebContents().some((contents) => contents.getURL() === expected), url)).toBe(true)
    await expect.poll(() => app.evaluate(async ({ webContents }, expected) => {
      const browser = webContents.getAllWebContents().find((contents) => contents.getURL() === expected)
      return browser?.executeJavaScript("document.body.textContent")
    }, url)).toBe(`${session.workspacePorts.primary}:${session.worktreePath}`)
  }
  expect(created[0]!.workspacePorts.primary).not.toBe(created[1]!.workspacePorts.primary)
  await window.locator('[data-testid^="editor-tab-chat-"]').filter({ visible: true }).first().getByRole("tab").click()
  await window.getByRole("button", { name: "Stop Dev" }).click()
  const stopped = `http://127.0.0.1:${created[1]!.workspacePorts.primary}`
  await expect.poll(async () => { try { await fetch(stopped); return false } catch { return true } }).toBe(true)
  const alive = await fetch(`http://127.0.0.1:${created[0]!.workspacePorts.primary}`)
  expect(await alive.text()).toContain(created[0]!.worktreePath)
  const row = window.getByTestId(`session-row-${created[1]!.id}`)
  await row.hover()
  await row.getByRole("button", { name: /^Archive / }).click()
  expect(await (await fetch(`http://127.0.0.1:${created[0]!.workspacePorts.primary}`)).text()).toContain(created[0]!.worktreePath)
})

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("two isolated servers have distinct previews and stopping one preserves the other", async ({ launchApp }) => {
  const { window, app, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  writeFileSync(join(repoPath, "preview-server.cjs"), `const http = require('node:http'); http.createServer((req,res) => res.end(process.env.JINGLER_PORT + ':' + process.env.JINGLER_WORKSPACE_PATH)).listen(Number(process.env.JINGLER_PORT), '127.0.0.1');`)
  execFileSync("git", ["add", "preview-server.cjs"], { cwd: repoPath })
  execFileSync("git", ["commit", "-m", "add preview fixture"], { cwd: repoPath })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
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


test("primary and extra port environments survive restart; UI reassignment preserves an unrelated listener", async ({ launchApp }) => {
  test.setTimeout(90000)
  const launched = await launchApp({ configured: true, withRepo: true })
  const { repoPath, home } = launched
  let window = launched.window
  writeFileSync(join(repoPath, "port-env.cjs"), `const http=require('node:http');const body=JSON.stringify({primary:process.env.JINGLER_PORT,api:process.env.JINGLER_API_PORT,workspace:process.env.JINGLER_WORKSPACE_PATH,root:process.env.JINGLER_ROOT_PATH});for(const port of [process.env.JINGLER_PORT,process.env.JINGLER_API_PORT])http.createServer((req,res)=>res.end(body)).listen(Number(port),'127.0.0.1');`)
  execFileSync("git", ["add", "port-env.cjs"], { cwd: repoPath })
  execFileSync("git", ["commit", "-m", "port environment fixture"], { cwd: repoPath })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click(); await addProject(window, repoPath); await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects", exact: true }).click()
  await window.getByLabel("Run commands").fill("Env=node port-env.cjs")
  await window.getByLabel("Additional service ports").fill("API=43000")
  await window.getByLabel("Preview URL template").fill("http://127.0.0.1:{API_port}")
  await window.getByRole("checkbox").check()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()
  await window.getByTestId("new-session").click()
  await window.getByRole("button", { name: "Create workspace" }).click()
  await expect(window.getByRole("button", { name: "Run Env" })).toBeVisible({ timeout: 20000 })
  const sessions = () => JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
  const session = sessions()[0]
  const assigned = structuredClone(session.workspacePorts) as { primary: number; extras: { API: number } }
  const current = () => sessions().find((item: { id: string }) => item.id === session.id)
  expect(assigned.extras.API).not.toBe(assigned.primary)
  const assertEnvironment = async (ports: typeof assigned) => {
    const expected = { primary: String(ports.primary), api: String(ports.extras.API), workspace: session.worktreePath, root: repoPath }
    for (const port of [ports.primary, ports.extras.API]) {
      await expect.poll(async () => { try { return await (await fetch(`http://127.0.0.1:${port}`)).json() } catch { return null } }).toEqual(expected)
    }
  }
  await window.getByRole("button", { name: "Run Env" }).click()
  await assertEnvironment(assigned)
  await window.getByRole("button", { name: "Open preview", exact: true }).click()
  await expect.poll(() => launched.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(contents => contents.getURL() === url), `http://127.0.0.1:${assigned.extras.API}/`)).toBe(true)
  await window.locator('[data-testid^="editor-tab-chat-"]').filter({ visible: true }).first().getByRole("tab").click()
  await window.getByRole("button", { name: "Stop Env" }).click()
  await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${assigned.primary}`); return false } catch { return true } }).toBe(true)
  await launched.app.close()
  const reopened = await launchApp({ home, reposDir: launched.reposDir, userDataDir: launched.userDataDir, configured: true })
  window = reopened.window
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId(`session-row-${session.id}`).click()
  await expect(window.getByRole("button", { name: "Run Env" })).toBeVisible()
  expect(current().workspacePorts).toEqual(assigned)
  await window.getByRole("button", { name: "Run Env" }).click()
  await assertEnvironment(assigned)
  await window.getByRole("button", { name: "Stop Env" }).click()
  await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${assigned.primary}`); return false } catch { return true } }).toBe(true)
  // This server belongs to the acceptance runner, never to Jingler's process registry.
  const unrelated = createServer((_request, response) => response.end("unrelated owner alive"))
  await new Promise<void>((resolve, reject) => { unrelated.once("error", reject); unrelated.listen(assigned.primary, "127.0.0.1", resolve) })
  try {
    await window.getByRole("button", { name: "Check ports", exact: true }).click()
    await expect(window.getByRole("alert").filter({ hasText: `Ports ${assigned.primary}` })).toBeVisible()
    await window.getByRole("button", { name: "Reassign ports", exact: true }).click()
    await expect.poll(() => current().workspacePorts.primary).not.toBe(assigned.primary)
    const reassigned = current().workspacePorts as typeof assigned
    expect(reassigned.extras.API).not.toBe(reassigned.primary)
    await expect(window.getByTestId("workspace-port")).toHaveText(`Port ${reassigned.primary}`)
    expect(await (await fetch(`http://127.0.0.1:${assigned.primary}`)).text()).toBe("unrelated owner alive")
    await window.getByRole("button", { name: "Run Env" }).click()
    await assertEnvironment(reassigned)
    await window.getByRole("button", { name: "Stop Env" }).click()
    await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${reassigned.primary}`); return false } catch { return true } }).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${assigned.primary}`)).text()).toBe("unrelated owner alive")
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close(error => error ? reject(error) : resolve()))
  }
})

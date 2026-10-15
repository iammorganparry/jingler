import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { SeedSession } from "./fixtures.js"
import { appShell, expect, test } from "./fixtures.js"

const SESSION: SeedSession = {
  id: "s_issue_view",
  repo: "acme/widget",
  branch: "feat/issue-view",
  title: "Issue view session",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  linkedIssues: [{ providerId: "github", id: "1", identifier: "#1", title: "Widget crashes", url: "https://github.com/acme/widget/issues/1", labels: [] }],
  selectedIssue: { providerId: "github", id: "1" },
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-11T00:00:00.000Z"
}

const issue = {
  number: 1, title: "Widget crashes", state: "OPEN", body: "It crashes on start.",
  url: "https://github.com/acme/widget/issues/1", author: { login: "octocat" },
  assignees: [], labels: [{ name: "bug", color: "ff0000" }],
  createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-02T08:00:00.000Z",
  comments: [{ author: { login: "lee" }, body: "Existing comment", createdAt: "2026-10-01T09:00:00.000Z" }]
}

test("issue tab renders through the shared reading shell and closes via the ⋯ menu", async ({ launchApp }) => {
  const root = mkdtempSync(join(tmpdir(), "jingler-e2e-issue-view-"))
  const bin = join(root, "bin")
  const log = join(root, "writes.log")
  const posted = join(root, "posted.json")
  try {
    mkdirSync(bin)
    writeFileSync(log, "")
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env node",
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "if (args[0] === 'auth') process.exit(0)",
      `const posted = ${JSON.stringify(posted)}`,
      `const view = () => { const i = ${JSON.stringify(JSON.stringify(issue))}; const o = JSON.parse(i); try { o.comments.push(...JSON.parse(fs.readFileSync(posted, 'utf8'))) } catch {} return JSON.stringify(o) }`,
      "if (args[0] === 'issue' && args[1] === 'view') { console.log(view()); process.exit(0) }",
      "if (args[0] === 'issue' && args[1] === 'comment') {",
      "  if (fs.existsSync(posted + '.fail')) { console.error('GraphQL: denied'); process.exit(1) }",
      "  let list = []; try { list = JSON.parse(fs.readFileSync(posted, 'utf8')) } catch {}",
      "  list.push({ author: { login: 'me' }, body: args[args.indexOf('--body') + 1], createdAt: new Date().toISOString() })",
      "  fs.writeFileSync(posted, JSON.stringify(list))",
      `  fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n'); process.exit(0)`,
      "}",
      `if (args[0] === 'issue' && args[1] === 'close') { fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n'); process.exit(0) }`,
      "console.error('unsupported gh command: ' + args.join(' '))",
      "process.exit(1)"
    ].join("\n"))
    chmodSync(join(bin, "gh"), 0o755)

    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      sessions: [SESSION],
      e2eEnv: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId(`session-row-${SESSION.id}`).click()
    await window.getByRole("button", { name: "#1", exact: true }).click()

    const header = window.getByTestId("reading-header")
    await expect(header.getByRole("heading", { name: "Widget crashes #1" })).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId("issue-meta-line")).toContainText("Open")
    await expect(window.getByTestId("issue-meta-line")).toContainText("octocat")
    await expect(window.getByTestId("reading-column")).toContainText("Existing comment")

    // A failed post keeps the draft and shows an inline error; a retry then appears without a reload.
    const composer = window.getByTestId("comment-composer")
    const box = composer.getByLabel("Leave a comment")
    writeFileSync(`${posted}.fail`, "")
    await box.fill("Looking into it")
    await composer.getByRole("button", { name: "Comment", exact: true }).click()
    await expect(window.getByTestId("comment-composer-error")).toContainText("denied")
    await expect(box).toHaveValue("Looking into it")
    rmSync(`${posted}.fail`)
    await composer.getByRole("button", { name: "Comment", exact: true }).click()
    await expect(window.getByTestId("reading-column")).toContainText("Looking into it")
    await expect(box).toHaveValue("")
    expect(readFileSync(log, "utf8")).toContain("issue comment 1 --repo acme/widget --body Looking into it")

    await header.getByRole("button", { name: "More actions" }).click()
    await window.getByRole("menuitem", { name: "Close issue" }).click()
    await expect.poll(() => readFileSync(log, "utf8")).toContain("issue close 1 --repo acme/widget")
    await expect(window.getByTestId("issue-meta-line")).toContainText("Closed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
  try {
    mkdirSync(bin)
    writeFileSync(log, "")
    writeFileSync(join(bin, "gh"), [
      "#!/usr/bin/env node",
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "if (args[0] === 'auth') process.exit(0)",
      `if (args[0] === 'issue' && args[1] === 'view') { console.log(${JSON.stringify(JSON.stringify(issue))}); process.exit(0) }`,
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

    await header.getByRole("button", { name: "More actions" }).click()
    await window.getByRole("menuitem", { name: "Close issue" }).click()
    await expect.poll(() => readFileSync(log, "utf8")).toContain("issue close 1 --repo acme/widget")
    await expect(window.getByTestId("issue-meta-line")).toContainText("Closed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

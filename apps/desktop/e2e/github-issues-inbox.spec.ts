import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const row = (number: number, repository: string, title: string) => ({
  number, repository: { nameWithOwner: repository }, title, state: "OPEN",
  url: `https://github.com/${repository}/issues/${number}`, updatedAt: `2026-10-0${number}T08:00:00.000Z`,
  author: { login: "octocat", avatarUrl: null }, comments: { totalCount: 1 },
  labels: { nodes: [{ name: "bug", color: "ff0000" }] }, assignees: { nodes: [] }
})

const inbox = [{ data: { viewer: { login: "octocat" }, search: {
  nodes: [row(1, "acme/widget", "Widget crashes"), row(2, "acme/api", "API times out")],
  pageInfo: { hasNextPage: false, endCursor: null }
} } }]

const detail = (number: number, title: string) => ({
  number, title, state: "OPEN", body: `Body of ${title}`, url: `https://github.com/acme/widget/issues/${number}`,
  author: { login: "octocat" }, assignees: [], labels: [], updatedAt: "2026-10-01T08:00:00.000Z",
  createdAt: "2026-10-01T08:00:00.000Z",
  comments: [{ id: "c1", author: { login: "lee" }, body: "Existing comment", createdAt: "2026-10-01T09:00:00.000Z" }]
})

test("browses, filters, comments on and closes issues through authenticated gh", async ({ launchApp }) => {
  const root = mkdtempSync(join(tmpdir(), "jingler-e2e-issues-"))
  const bin = join(root, "bin")
  const log = join(root, "writes.log")
  try {
    mkdirSync(bin)
    writeFileSync(log, "")
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const joined = args.join(' ')",
      `const inbox = ${JSON.stringify(inbox)}`,
      `const detail = ${JSON.stringify(detail(1, "Widget crashes"))}`,
      "if (args[0] === 'auth' && args[1] === 'status') process.exit(0)",
      "if (args[0] === 'api' && args[1] === 'graphql' && joined.includes('is:issue')) { console.log(JSON.stringify(inbox)); process.exit(0) }",
      "if (args[0] === 'issue' && args[1] === 'view') { console.log(JSON.stringify(detail)); process.exit(0) }",
      "if (args[0] === 'issue' && (args[1] === 'comment' || args[1] === 'close')) {",
      `  fs.appendFileSync(${JSON.stringify(log)}, args.slice(0, 5).join(' ') + '\\n'); process.exit(0)`,
      "}",
      "console.error('unsupported gh command: ' + joined)",
      "process.exit(1)"
    ].join("\n")
    writeFileSync(join(bin, "gh"), script)
    chmodSync(join(bin, "gh"), 0o755)

    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      e2eEnv: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }
    })

    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("issues-sidebar-item").click()
    const issues = window.getByTestId("issue-inbox")
    await expect(issues.getByRole("button", { name: /Widget crashes/ })).toBeVisible({ timeout: 20_000 })
    await expect(issues.getByRole("button", { name: /API times out/ })).toBeVisible()

    await issues.getByRole("button", { name: "Filter by repository" }).click()
    await window.getByRole("option", { name: "acme/api", exact: true }).click()
    await expect(issues.getByRole("button", { name: /Widget crashes/ })).toHaveCount(0)
    await expect(issues.getByRole("button", { name: /API times out/ })).toBeVisible()
    await issues.getByRole("button", { name: "Clear filters" }).click()

    await issues.getByRole("button", { name: /Widget crashes/ }).click()
    await expect(issues.getByRole("heading", { name: "Widget crashes" })).toBeVisible()
    await expect(issues.getByText("Existing comment")).toBeVisible()

    await issues.getByPlaceholder("Leave a comment…").fill("Looking into it")
    await issues.getByRole("button", { name: "Comment", exact: true }).click()
    await expect.poll(() => readFileSync(log, "utf8")).toContain("issue comment 1 --repo acme/widget")

    await issues.getByRole("button", { name: "Close issue" }).click()
    await expect.poll(() => readFileSync(log, "utf8")).toContain("issue close 1 --repo acme/widget")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

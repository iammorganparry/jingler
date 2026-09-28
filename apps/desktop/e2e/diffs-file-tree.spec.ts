import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"
import { PIERRE_HOST_CLASS, verticalScrollOwner } from "./pierre-helpers.js"
import { openChangedFile } from "./explorer.js"


const seeded = (worktreePath: string): SeedSession => ({
  id: "s_pierre_review",
  repo: "widget",
  branch: "jingler/pierre-review",
  title: "Pierre review session",
  status: "idle",
  diff: { added: 2, removed: 2 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-05T00:00:00.000Z",
  worktreePath
})

test("uses the shared legacy Jingler Pierre skin in the Changes review diff", async ({
  launchApp
}) => {
  const originalLines = [
    "export const login = oldLogin",
    ...Array.from(
      { length: 178 },
      (_, index) => `export const stable_${index + 2} = ${index + 2}`
    ),
    "export const stable_180 = 180"
  ]
  const changedLines = originalLines.map((line, index) =>
    index === 0
      ? "export const login = nextLogin"
      : index >= 100
        ? line.replace(` = ${index + 1}`, ` = ${index + 1 + 1_000}`)
        : line
  )
  const original = `${originalLines.join("\n")}\n`
  const changed = `${changedLines.join("\n")}\n`
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src", "auth"), { recursive: true })
      mkdirSync(join(repoPath, "src", "store"), { recursive: true })
      const loginPath = join(repoPath, "src", "auth", "login.ts")
      writeFileSync(loginPath, original)
      writeFileSync(join(repoPath, "src", "store", "cache.ts"), "export const ttl = 30\n")
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "seed review", "--no-gpg-sign"], {
        cwd: repoPath
      })
      writeFileSync(loginPath, changed)
      writeFileSync(join(repoPath, "src", "store", "cache.ts"), "export const ttl = 60\n")
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1800, height: 900 })
  await sessionRow(window, "Pierre review session").click()
  const closeTerminal = window.getByRole("button", { name: "Close zsh" })
  if (await closeTerminal.isVisible()) {
    await closeTerminal.click()
    await expect(closeTerminal).toBeHidden()
  }
  const review = (await openChangedFile(window, "src/auth/login.ts"))
    .getByRole("region", { name: "Code review changes" })
  await expect(review).toBeVisible()
  const diff = review.locator("diffs-container").first()
  await expect(review).toHaveAttribute("data-jingler-pierre-view", "code-view")
  await expect(review).toHaveClass(PIERRE_HOST_CLASS)

  const scrollOwner = await verticalScrollOwner(review)
  const scrollMetrics = await scrollOwner.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY
  }))
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
  expect(["auto", "scroll"]).toContain(scrollMetrics.overflowY)
  await scrollOwner.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect
    .poll(() => scrollOwner.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await scrollOwner.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect.poll(() => scrollOwner.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(window.getByText("export const login = nextLogin", { exact: true })).toBeVisible({
    timeout: 30_000
  })

  const metrics = await diff.evaluate((element) => {
    const root = element.shadowRoot
    if (root === null) throw new Error("Pierre shadow root is missing")
    const header = root.querySelector<HTMLElement>('[data-diffs-header="custom"]')
    const line = root.querySelector<HTMLElement>(
      '[data-line-type="change-addition"][data-line]'
    )
    const gutter = root.querySelector<HTMLElement>(
      '[data-line-type="change-addition"][data-column-number]'
    )
    const token = line?.querySelector<HTMLElement>("span")
    if (header === null || line === null || gutter === null || token === null) {
      throw new Error("Pierre visual-contract node is missing")
    }
    const lineStyle = getComputedStyle(line)
    return {
      fontSize: Math.round(Number.parseFloat(lineStyle.fontSize)),
      lineHeight: Math.round(Number.parseFloat(lineStyle.lineHeight) * 100) / 100,
      rowHeight: Math.round(line.getBoundingClientRect().height),
      headerHeight: Math.round(header.getBoundingClientRect().height),
      gutterWidth: Math.round(gutter.getBoundingClientRect().width),
      sign: getComputedStyle(line, "::before").content,
      signWidth: Math.round(Number.parseFloat(getComputedStyle(line, "::before").width)),
      syntaxColor: getComputedStyle(token).color,
      lineColor: lineStyle.color,
      additionBackground: lineStyle.backgroundColor
    }
  })
  expect(metrics).toMatchObject({
    fontSize: 11,
    lineHeight: 20.35,
    rowHeight: 21,
    gutterWidth: 80,
    signWidth: 16
  })
  expect(metrics.headerHeight).toBeGreaterThanOrEqual(34)
  expect(metrics.sign).toContain("+")
  expect(metrics.syntaxColor).not.toBe(metrics.lineColor)
  expect(metrics.additionBackground).not.toBe("rgba(0, 0, 0, 0)")

  const addedLine = diff
    .locator('[data-line-type="change-addition"][data-column-number="1"]')
    .first()
  const addedToken = diff
    .locator('[data-line-type="change-addition"][data-line="1"] span')
    .first()
  const syntaxColorBeforeSelection = await addedToken.evaluate(
    (element) => getComputedStyle(element).color
  )
  await expect(addedLine).toBeVisible()
  await addedLine.click({ position: { x: 6, y: 6 } })

  await expect(addedLine).toHaveAttribute("data-selected-line", "single")
  expect(await addedToken.evaluate((element) => getComputedStyle(element).color)).toBe(
    syntaxColorBeforeSelection
  )
  expect(
    await addedLine.evaluate((element) =>
      Math.round(Number.parseFloat(getComputedStyle(element, "::after").width))
    )
  ).toBe(2)

  await expect(window.getByText("login.ts new L1", { exact: true })).toBeVisible()
  await expect(
    window.getByPlaceholder("Suggest a change or ask the agent to fix this…")
  ).toBeVisible()
})

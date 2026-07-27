import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The Code Review tab's renderer footprint, over a changeset far larger than a
 * component test can express.
 *
 * This guards a bug that cost gigabytes. `ReviewDiff` is deliberately
 * non-virtualized — correct when the tab showed one file at a time, and quietly
 * false once the continuous scroll stacked every file. Each line is ~10 React
 * fibers (row, two gutters, sign, one span per syntax token), so the changeset
 * below mounted about half a million of them and held ~320MB; two panes on a
 * real branch is where the 5GB renderer came from. Worse, none of it was
 * memoized, so every frame of a review-pane resize drag re-rendered the lot at
 * ~35MB of garbage per pass.
 *
 * `DeferredSection` mounts a file's lines only near the viewport, and `DiffLine`
 * is memoized behind stable handlers. Both ceilings below are ~3x the measured
 * post-fix numbers: this is a guard against a regression to "mount everything",
 * not a benchmark, and it must not fail because a row grew a span.
 *
 * Heap is read over CDP. `performance.memory` is quantized hard enough in
 * Chromium that it reports the same value all run, which reads as "no leak"
 * whatever the truth is.
 */

const FILES = 14
const LINES = 900
/** ~12.6k rendered rows — comfortably past where the old path fell over. */
const MOUNTED_CEILING_MB = 150
/** What one full re-render pass may allocate (the resize-drag frame cost). */
const RERENDER_CEILING_MB = 12

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_review_mem",
  repo: "widget",
  branch: "jingler/review-memory",
  title: "Review memory session",
  status: "idle",
  cli: "claude",
  diff: { added: FILES * LINES, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-26T00:00:00.000Z",
  worktreePath
})

const bigSource = (n: number, rev: number): string => {
  const lines: Array<string> = [`export const MODULE_${n} = ${n} // rev ${rev}`]
  for (let i = 0; i < LINES; i++) {
    lines.push(
      `export function fn_${n}_${i}(input: string, count = ${i}): string {`,
      `  const template = \`value \${input} at ${i} in module ${n} rev ${rev}\``,
      `  return template.repeat(Math.max(1, count % 7))`,
      `}`
    )
  }
  return lines.join("\n")
}

test("the code review tab holds a large changeset without mounting all of it", async ({
  launchApp
}) => {
  let repoPath = ""
  const { window, app } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (ctx) => [seeded(ctx.repoPath)],
    seed: (ctx) => {
      repoPath = ctx.repoPath
      for (let n = 0; n < FILES; n++) {
        writeFileSync(join(ctx.repoPath, `module_${n}.ts`), bigSource(n, 0))
      }
    }
  })

  const cdp = await app.context().newCDPSession(window)
  /** Renderer bytes that SURVIVE a collection — the only number a leak shows in. */
  const heapMb = async (): Promise<number> => {
    await cdp.send("HeapProfiler.collectGarbage")
    const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number }
    return usedSize / 1024 / 1024
  }
  const show = (label: string, mb: number): void =>
    console.log(`${label.padEnd(26)} ${mb.toFixed(1)}MB`)

  const openChanges = async (): Promise<void> => {
    await window.getByRole("button", { name: "Changes" }).first().click()
    await window
      .getByRole("button", { name: "Deslop" })
      .first()
      .waitFor({ state: "visible", timeout: 120_000 })
    await window.waitForTimeout(1200)
  }

  await window.getByTestId("session-row-s_review_mem").click()
  const baseline = await heapMb()
  show("baseline", baseline)

  await openChanges()
  const mounted = await heapMb()
  show("changes mounted", mounted)
  expect(mounted).toBeLessThan(MOUNTED_CEILING_MB)

  // Every line of every file mounted at once is what this guards against, so
  // assert on the DOM directly too — the heap ceiling alone could be met by a
  // smaller row while the "mount everything" bug survived intact.
  const rowCount = await window.locator("[data-review-line]").count()
  console.log(`mounted diff rows          ${rowCount}`)
  expect(rowCount).toBeLessThan(FILES * LINES)

  // A re-render pass over a mounted diff — what a resize drag does per frame.
  // Unmemoized, this allocated ~35MB each time.
  const beforeResize = await heapMb()
  for (let i = 0; i < 6; i++) {
    await window.setViewportSize({ width: 1200 + i * 40, height: 800 })
    await window.waitForTimeout(150)
  }
  const afterResize = await heapMb()
  show("after 6 resize passes", afterResize)
  expect(afterResize - beforeResize).toBeLessThan(RERENDER_CEILING_MB)

  // The diff changing under a mounted pane — an agent editing while you watch.
  // This used to step up ~118MB and never give it back.
  const beforeChurn = await heapMb()
  for (let rev = 1; rev <= 4; rev++) {
    for (let n = 0; n < FILES; n++) {
      writeFileSync(join(repoPath, `module_${n}.ts`), bigSource(n, rev))
    }
    await window.getByRole("button", { name: "Conversation" }).click()
    await window.waitForTimeout(300)
    await openChanges()
  }
  const afterChurn = await heapMb()
  show("after 4 diff rewrites", afterChurn)
  expect(afterChurn).toBeLessThan(MOUNTED_CEILING_MB)
})

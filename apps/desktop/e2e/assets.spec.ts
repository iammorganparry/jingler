import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Asset viewing, end to end against the built app.
 *
 * The three routes from agent output into the Preview dock, exercised through a
 * real transcript over a real worktree:
 *  - a `Write` tool card's filename,
 *  - an inline `docs/spec.md` code span in prose,
 *  - a relative markdown link.
 *
 * Two things here are deliberately asserted on CHROME rather than pixels. The
 * PDF is rendered by a native `WebContentsView` (Chromium's own viewer, which is
 * why the app ships no pdf.js) and lives outside the DOM entirely, exactly like
 * the browser pane in previews.spec.ts and the xterm canvas in terminal.spec.ts
 * — so the spec checks that the placeholder mounts, never what the PDF looks
 * like.
 *
 * One asset is deliberately left UNCOMMITTED. Clickability is gated on the
 * worktree's file list, and a file the agent wrote this turn is untracked until
 * something commits it — so a tracked-only list would be blind to precisely the
 * file the operator most wants to open. `notes.md` is that case, in the shape it
 * actually occurs.
 */

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

/** A 1×1 PNG — real bytes, so the image branch decodes something valid. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/**
 * The smallest thing Chromium will accept as a PDF. Its contents do not matter —
 * nothing in this spec reads them — only that the file exists and is tracked.
 */
const MINIMAL_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
  ""
].join("\n")

const seedAssets = ({ repoPath }: { repoPath: string }): void => {
  mkdirSync(join(repoPath, "docs"), { recursive: true })
  mkdirSync(join(repoPath, "out"), { recursive: true })
  mkdirSync(join(repoPath, "src"), { recursive: true })
  writeFileSync(join(repoPath, "docs", "spec.md"), "# The Spec\n\nA **bold** claim.\n")
  writeFileSync(join(repoPath, "out", "results.csv"), "name,count\nalpha,12\nbeta,7\n")
  writeFileSync(join(repoPath, "src", "main.ts"), "export const answer = 41\n")
  writeFileSync(join(repoPath, "src", "clean.ts"), "export const clean = true\n")
  writeFileSync(join(repoPath, "other.md"), "# Other Session\n\nA second asset context.\n")
  writeFileSync(join(repoPath, "archive.bin"), "unsupported but browsable\n")
  writeFileSync(join(repoPath, "chart.png"), Buffer.from(PNG_BASE64, "base64"))
  writeFileSync(join(repoPath, "report.pdf"), MINIMAL_PDF)
  git(repoPath, ["add", "-A"])
  git(repoPath, ["commit", "-m", "assets", "--no-gpg-sign"])
  // Written but NOT committed — this is what a file the agent just made looks
  // like. It must still be openable.
  writeFileSync(join(repoPath, "notes.md"), "# Fresh Notes\n\nWritten this turn.\n")
  writeFileSync(join(repoPath, ".gitignore"), "ignored.md\n")
  writeFileSync(join(repoPath, "ignored.md"), "# Ignored\n")
  writeFileSync(join(repoPath, "src", "main.ts"), "export const answer = 42\n")
}

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_assets",
    repo: "widget",
    branch: "chore/assets",
    title: "Write the spec",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  },
  {
    id: "s_assets_other",
    repo: "widget",
    branch: "jingler/assets-other",
    title: "Other asset session",
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:01.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

const PROSE = [
  "I wrote the spec. See `docs/spec.md`, and the numbers in `out/results.csv`.",
  "",
  "You can also read [the spec](./docs/spec.md) directly.",
  "",
  "Upgraded the toolchain to `v1.2.3` while I was there.",
  "",
  "The generated deck is at `report.pdf`.",
  "",
  "Fresh, uncommitted output lives in `notes.md`; build spew is in `ignored.md`.",
  ""
].join("\n")

/**
 * `target` is worktree-RELATIVE here, where a real harness reports an absolute
 * path. That is a fixture constraint, not a shortcut: `transcripts` is a static
 * record written before launch, so the temp repo's absolute path does not exist
 * yet. The absolute form is matched by suffix and is covered by
 * `path-detect.test.ts`; what this file is for is the wiring.
 */
const TRANSCRIPT = [
  {
    id: "a_write",
    role: "assistant",
    streaming: false,
    createdAt: "2026-07-11T00:00:00.000Z",
    parts: [
      {
        _tag: "Tool",
        tool: {
          id: "t_write",
          name: "Write",
          target: "docs/spec.md",
          status: "success",
          meta: null,
          diff: null,
          preview: null
        }
      },
      { _tag: "Text", text: PROSE }
    ]
  }
]

const OTHER_TRANSCRIPT = [
  {
    id: "a_other",
    role: "assistant",
    streaming: false,
    createdAt: "2026-07-11T00:00:01.000Z",
    parts: [
      { _tag: "Text", text: "This session's document is `other.md`." }
    ]
  }
]

test("opens worktree assets from the transcript in the Preview dock", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: seededSessions,
    transcripts: {
      s_assets: TRANSCRIPT,
      s_assets_other: OTHER_TRANSCRIPT
    }
  })

  await expect(appShell(window)).toBeVisible()

  // ── Route 1: the tool card's filename ────────────────────────────────────
  // A `Write` card is literally the moment the agent created the file, which is
  // why it is the highest-signal of the three routes.
  const cardPath = window.getByTitle("Open spec.md")
  await expect(cardPath).toBeVisible({ timeout: 15_000 })
  await cardPath.click()

  // The dock shows itself when an asset is opened — focusing a tab in a hidden
  // panel would look like nothing happened.
  await expect(window.getByRole("button", { name: "Hide preview" })).toBeVisible()
  // Rendered markdown, not the file's source text.
  await expect(window.getByRole("heading", { name: "The Spec" })).toBeVisible({ timeout: 15_000 })

  // The pinned Browser tab is always there to go back to.
  await expect(window.getByTitle("Browser", { exact: true })).toBeVisible()

  // ── Route 2: an inline code span in prose ────────────────────────────────
  const inlineCsv = window.getByTitle("Open out/results.csv")
  await expect(inlineCsv).toBeVisible()
  await inlineCsv.click()
  // The CSV's header row proves it parsed rather than rendering as raw text.
  await expect(window.getByText("count", { exact: true })).toBeVisible({ timeout: 15_000 })

  // A version string in the same paragraph must NOT have become a link — the
  // failure this guards is every third token in a transcript turning into a dead
  // affordance.
  await expect(window.getByTitle("Open v1.2.3")).toHaveCount(0)

  // ── Route 3: a relative markdown link ────────────────────────────────────
  // Streamdown hardens a relative href into an inert button, so this only works
  // because `Markdown` overrides the link component (see markdown.tsx).
  await window.getByRole("button", { name: "the spec" }).click()
  await expect(window.getByRole("heading", { name: "The Spec" })).toBeVisible()

  // ── Tabs persist; the browser survives a round trip ──────────────────────
  // Switching away from an asset and back must not close it: the dock's whole
  // reason for having tabs is that the browser's page, history and scroll live
  // in a native view that `close()` would destroy.
  await window.getByTitle("Browser", { exact: true }).click()
  await expect(window.getByLabel("Preview URL")).toBeVisible()
  await window.getByTitle("docs/spec.md", { exact: true }).click()
  await expect(window.getByRole("heading", { name: "The Spec" })).toBeVisible()

  // ── An UNCOMMITTED file remains browsable ────────────────────────────────
  // The headline case: a file the agent wrote this turn is untracked, so a
  // tracked-only file list would leave it inert — exactly the file the operator
  // came to read. Markdown keeps its rendered document presentation.
  await window.getByTitle("Open notes.md").click()
  await expect(window.getByRole("heading", { name: "Fresh Notes" })).toBeVisible({ timeout: 15_000 })

  // …but .gitignore is still honoured, so build spew never becomes a link.
  await expect(window.getByTitle("Open ignored.md")).toHaveCount(0)

  // ── Persistent Pierre repository tree + source canvas ───────────────────
  // A right-docked preview cannot leave both a readable tree and canvas, so the
  // tree is a sheet. It still has the same hierarchical/status-aware model.
  await window.getByRole("button", { name: "Repository files" }).click()
  const tree = window.locator("[data-jingler-pierre-file-tree]")
  await expect(tree).toBeVisible()
  const modifiedSource = tree.locator('[data-item-path="src/main.ts"]')
  const freshNotes = tree.locator('[data-item-path="notes.md"]')
  await expect(modifiedSource).toHaveAttribute("data-item-git-status", "modified")
  await expect(freshNotes).toHaveAttribute("data-item-git-status", "untracked")
  await expect(tree.locator('[data-item-path="ignored.md"]')).toHaveCount(0)
  await expect(tree.locator('[data-item-path^=".git/"]')).toHaveCount(0)

  // Keyboard focus plus a seed character opens Pierre's built-in search.
  await modifiedSource.focus()
  await modifiedSource.press("r")
  await expect(tree.locator('[data-file-tree-search-input]')).toHaveValue("r")
  await tree.locator('[data-file-tree-search-input]').press("Escape")

  // Selecting through the tree routes through the dock machine: a tab opens,
  // the sheet closes, and changed source uses Pierre FileDiff.
  await modifiedSource.click()
  await expect(window.getByTitle("src/main.ts", { exact: true })).toBeVisible()
  await expect(window.getByText("export const answer = 42", { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.locator('[data-jingler-pierre-view="diff"]')).toBeVisible()

  // Bottom docking leaves room for a persistent tree beside the canvas. Clean
  // source then renders through Pierre File rather than the removed row renderer.
  const previewControls = window.getByRole("button", { name: "Hide preview" }).locator("..")
  await previewControls.getByRole("button", { name: "Dock bottom" }).click()
  await expect(tree).toBeVisible()
  const cleanSource = tree.locator('[data-item-path="src/clean.ts"]')
  await cleanSource.focus()
  await cleanSource.press("Enter")
  await expect(window.getByText("export const clean = true", { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.locator('[data-jingler-pierre-view="file"]')).toBeVisible()

  // Unknown file types are still repository entries and land in the same canvas
  // as an honest notice rather than disappearing from navigation.
  const archive = tree.locator('[data-item-path="archive.bin"]')
  await archive.focus()
  await archive.press("Enter")
  await expect(window.getByText("No preview available", { exact: true })).toBeVisible()

  // Images use the same persistent selection/canvas path as source and notices.
  const image = tree.locator('[data-item-path="chart.png"]')
  await image.focus()
  await image.press("Enter")
  await expect(window.getByRole("img", { name: "chart.png" })).toBeVisible()

  // ── PDF: chrome only, never pixels ──────────────────────────────────────
  // Chromium's own viewer paints a native WebContentsView over this hole, so
  // the renderer's job is to claim the space and get out of the way. Asserting
  // on the rendered PDF would be asserting on Electron.
  await window.getByTitle("Open report.pdf").click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeVisible({ timeout: 15_000 })
  const treeBox = await tree.boundingBox()
  const canvasBox = await window.getByTestId("asset-content-canvas").boundingBox()
  const pdfBox = await window.getByTestId("asset-pdf-placeholder").boundingBox()
  expect(treeBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  expect(pdfBox).not.toBeNull()
  expect(pdfBox!.x).toBeGreaterThanOrEqual(canvasBox!.x)
  expect(pdfBox!.y).toBeGreaterThanOrEqual(canvasBox!.y)
  expect(pdfBox!.x + pdfBox!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1)
  expect(pdfBox!.y + pdfBox!.height).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1)
  expect(treeBox!.x + treeBox!.width).toBeLessThanOrEqual(canvasBox!.x + 1)

  // Resizing the tree suspends the native surface during the drag, then measures
  // it again against the changed canvas. The post-drag bounds prove it did not
  // keep painting at the stale pre-drag rectangle.
  const treeResize = window.getByRole("separator", { name: "Resize repository browser" })
  const resizeBox = await treeResize.boundingBox()
  expect(resizeBox).not.toBeNull()
  await window.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + 20)
  await window.mouse.down()
  await window.mouse.move(resizeBox!.x + 48, resizeBox!.y + 20, { steps: 4 })
  await window.mouse.up()
  const resizedCanvas = await window.getByTestId("asset-content-canvas").boundingBox()
  const resizedPdf = await window.getByTestId("asset-pdf-placeholder").boundingBox()
  expect(resizedCanvas).not.toBeNull()
  expect(resizedPdf).not.toBeNull()
  expect(resizedPdf!.x).toBeGreaterThanOrEqual(resizedCanvas!.x)
  expect(resizedPdf!.x + resizedPdf!.width).toBeLessThanOrEqual(
    resizedCanvas!.x + resizedCanvas!.width + 1
  )

  // Switching back to a constrained dock turns the same model into a sheet.
  // Opening that sheet suspends the native PDF, so its rows remain clickable.
  await previewControls.getByRole("button", { name: "Dock right" }).click()
  await window.getByRole("button", { name: "Repository files" }).click()
  await tree.locator('[data-item-path="docs/spec.md"]').click()
  await expect(window.getByRole("heading", { name: "The Spec" })).toBeVisible()

  // Hiding the DOCK while a PDF is focused must take the overlay with it. The
  // native view is not hidden by hiding a div, and the bounds loop deliberately
  // holds its last good rect rather than pushing a 0x0 one — so a missed hide
  // leaves the PDF painted over the conversation until the app restarts.
  // Asserted through the dock's own chrome, which is the in-DOM proxy for it.
  await window.getByTitle("report.pdf", { exact: true }).click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeVisible()
  await window.getByRole("button", { name: "Hide preview" }).click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeHidden()
  await window.getByRole("button", { name: "Preview", exact: true }).click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeVisible()

  // A different session opening its own asset switches the active manager and
  // must remove the first session's native PDF before showing the new canvas.
  await window.getByTestId("session-row-s_assets_other").click()
  const otherAsset = window.getByTitle("Open other.md")
  await expect(otherAsset).toBeVisible({ timeout: 15_000 })
  await otherAsset.click()
  await expect(window.getByRole("heading", { name: "Other Session" })).toBeVisible()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeHidden()
  await window.getByTitle("report.pdf", { exact: true }).click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeVisible()
  await window.getByTestId("session-row-s_assets").click()

  // Closing an asset tab falls back to the Browser tab — the only one that is
  // guaranteed to still be there.
  await window.getByTitle("docs/spec.md", { exact: true }).click()
  await window.getByRole("button", { name: "Close spec.md" }).click()
  await expect(window.getByLabel("Preview URL")).toBeVisible()
})

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
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
  writeFileSync(join(repoPath, "docs", "spec.md"), "# The Spec\n\nA **bold** claim.\n")
  writeFileSync(join(repoPath, "out", "results.csv"), "name,count\nalpha,12\nbeta,7\n")
  writeFileSync(join(repoPath, "chart.png"), Buffer.from(PNG_BASE64, "base64"))
  writeFileSync(join(repoPath, "report.pdf"), MINIMAL_PDF)
  git(repoPath, ["add", "-A"])
  git(repoPath, ["commit", "-m", "assets", "--no-gpg-sign"])
  // Written but NOT committed — this is what a file the agent just made looks
  // like. It must still be openable.
  writeFileSync(join(repoPath, "notes.md"), "# Fresh Notes\n\nWritten this turn.\n")
  writeFileSync(join(repoPath, ".gitignore"), "ignored.md\n")
  writeFileSync(join(repoPath, "ignored.md"), "# Ignored\n")
}

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_assets",
    repo: "widget",
    branch: "starbase/assets",
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

test("opens worktree assets from the transcript in the Preview dock", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: seededSessions,
    transcripts: { s_assets: TRANSCRIPT }
  })

  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()

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

  // ── An UNCOMMITTED file is still openable ───────────────────────────────
  // The headline case: a file the agent wrote this turn is untracked, so a
  // tracked-only file list would leave it inert — exactly the file the operator
  // came to read.
  await window.getByTitle("Open notes.md").click()
  await expect(window.getByRole("heading", { name: "Fresh Notes" })).toBeVisible({
    timeout: 15_000
  })

  // …but .gitignore is still honoured, so build spew never becomes a link.
  await expect(window.getByTitle("Open ignored.md")).toHaveCount(0)

  // ── PDF: chrome only, never pixels ──────────────────────────────────────
  // Chromium's own viewer paints a native WebContentsView over this hole, so
  // the renderer's job is to claim the space and get out of the way. Asserting
  // on the rendered PDF would be asserting on Electron.
  await window.getByTitle("Open report.pdf").click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeVisible({ timeout: 15_000 })

  // Hiding the DOCK while a PDF is focused must take the overlay with it. The
  // native view is not hidden by hiding a div, and the bounds loop deliberately
  // holds its last good rect rather than pushing a 0x0 one — so a missed hide
  // leaves the PDF painted over the conversation until the app restarts.
  // Asserted through the dock's own chrome, which is the in-DOM proxy for it.
  await window.getByRole("button", { name: "Hide preview" }).click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeHidden()
  await window.getByRole("button", { name: "Preview", exact: true }).click()
  await expect(window.getByTestId("asset-pdf-placeholder")).toBeVisible()

  // Closing an asset tab falls back to the Browser tab — the only one that is
  // guaranteed to still be there.
  await window.getByTitle("docs/spec.md", { exact: true }).click()
  await window.getByRole("button", { name: "Close spec.md" }).click()
  await expect(window.getByLabel("Preview URL")).toBeVisible()
})

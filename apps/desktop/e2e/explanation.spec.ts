/** Explanation view (#456): a published explanation opens as a content tab and renders its article. */
import { createHash } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session: SeedSession = {
  id: "s_explanation",
  repo: "widget",
  branch: "feat/explanation",
  title: "Explanation test",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-12T10:00:00.000Z"
}

const sha12 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12)

/** Mirrors ExplanationStore's on-disk layout: `<home>/jingler/.jingler/<worktree>-<hash>/explanation-<hash>.json`. */
const seedExplanation = (home: string, worktreePath: string) => {
  const canonical = realpathSync(worktreePath)
  const dir = join(home, "jingler", ".jingler", `${basename(canonical)}-${sha12(canonical)}`)
  mkdirSync(dir, { recursive: true })
  const section = (id: string, title: string) => ({
    id,
    title,
    blocks: [
      { kind: "prose", id: `${id}-prose`, text: "The boundary is **typed**." },
      { kind: "table", id: `${id}-table`, headers: ["Part", "Role"], rows: [["Store", "Persist"]] }
    ]
  })
  writeFileSync(
    join(dir, `explanation-${sha12(session.id)}.json`),
    JSON.stringify({
      id: "explanation-e2e",
      sessionId: session.id,
      producingChatId: "chat-e2e",
      revision: 1,
      title: "How publishing works",
      summary: "A typed artifact flows from agent to view.",
      sections: [section("shape", "Runtime shape"), section("storage", "Storage")],
      updatedAt: "2026-10-12T12:00:00.000Z"
    })
  )
}

test("a published explanation opens as a tab and renders the article", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (context) => [{ ...session, worktreePath: context.repoPath }],
    seed: ({ home, repoPath }) => seedExplanation(home, repoPath)
  })
  await window.setViewportSize({ width: 1600, height: 900 })
  await window.getByTestId("session-row-s_explanation").click()

  await window.getByTestId("view-overflow-trigger").click()
  await window.getByTestId("open-explanation").click()

  await expect(window.getByTestId("editor-tab-view-explanation")).toHaveCount(1)
  await expect(window.getByRole("article", { name: "Technical explanation" })).toBeVisible()
  await expect(window.getByRole("heading", { name: "How publishing works" })).toBeVisible()
  await expect(window.getByRole("region", { name: "Runtime shape" })).toBeVisible()
  await expect(window.getByRole("table").first()).toBeVisible()
  // The rail only shows at >=1000px of container width; the content tab is narrower than that here.
  await expect(window.locator('nav[aria-label="Explanation contents"]')).toHaveCount(1)
})

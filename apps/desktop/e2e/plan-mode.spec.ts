import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_PLAN_TEMPLATE_HTML } from "@jingler/core"
import type { Page } from "@playwright/test"
import {
  appShell,
  DEFAULT_CLAUDE_MODEL,
  expect,
  planDirectory,
  type LaunchedApp,
  type SeedSession,
  test
} from "./fixtures.js"

const session = (
  cli: SeedSession["cli"] = "claude",
  id = `s_plan_${cli}`
) =>
  ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
    id,
    repo: "widget",
    branch: `jingler/${id}`,
    title: `${cli} plan`,
    status: "idle",
    cli,
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }]

// Plans are HTML documents now (rendered in the Tiptap "Notion-doc" editor), so
// the canonical file is `current-plan.html`, not the old `current-plan.mdx`.
const currentPlanPath = (launched: LaunchedApp): string =>
  join(planDirectory(launched.home, launched.repoPath), "current-plan.html")

const revisionOf = (file: string): number =>
  Number(/^revision:\s*(\d+)$/m.exec(readFileSync(file, "utf8"))?.[1] ?? 0)

const openSettings = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
}

const proposePlan = async (window: Page): Promise<void> => {
  const composer = window.getByPlaceholder(/Message .+…/)
  await composer.fill("[[plan]] refactor auth to a TokenStore")
  await composer.press("Enter")
  const review = window.getByRole("button", { name: "Plan Review" }).first()
  await expect(review).toBeVisible({ timeout: 20_000 })
  await review.click()
  await expect(window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  await expect(window.getByLabel("Plan document")).toBeVisible()
  await expect(window.getByLabel("Resize step list")).toHaveCount(0)
  await expect(window.getByLabel("Resize changes")).toHaveCount(0)
}

/**
 * There is no raw "Source" textarea anymore — the plan is one Tiptap document.
 * To make a persistable edit, click into the doc and type a unique marker at the
 * end of a known prose paragraph, then wait for the debounced autosave to settle.
 * The marker is appended after the Rollout paragraph so it never breaks the
 * "Implement stages in order" phrase other steps anchor on.
 */
const editSource = async (window: Page, marker: string): Promise<string> => {
  const anchor = window.getByText("Implement stages in order").first()
  await anchor.click()
  await window.keyboard.press("End")
  await window.keyboard.type(` ${marker}`)
  await expect(window.getByRole("status")).toContainText(/Editing|Saving/)
  await expect(window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  return marker
}

const selectText = async (window: Page, needle: string): Promise<void> => {
  const paragraph = window.getByText(new RegExp(needle)).first()
  await paragraph.click()
  await paragraph.evaluate((element, selectedText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let textNode = walker.nextNode()
    while (textNode && !textNode.textContent?.includes(selectedText)) {
      textNode = walker.nextNode()
    }
    if (!textNode?.textContent) throw new Error(`Could not select "${selectedText}"`)
    const start = textNode.textContent.indexOf(selectedText)
    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + selectedText.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }))
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  }, needle)
}

test("the PRD template validates, persists, and resets", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await openSettings(first.window)
  await first.window.getByRole("button", { name: "Plan", exact: true }).click()

  const source = first.window.getByLabel("Plan template source")
  // Plan-mode templates are validated as PRD HTML now: a fragment with no <h1>
  // title and no stage is rejected, and saving is blocked while it is invalid.
  await source.fill("<p>no title, no stage</p>")
  await expect(first.window.getByRole("alert")).toContainText(
    "A plan must contain at least one stage."
  )
  await expect(first.window.getByRole("button", { name: "Save template" })).toBeDisabled()

  const customised = DEFAULT_PLAN_TEMPLATE_HTML.replace(
    "<h2>Risks</h2>",
    "<h2>Constraints and risks</h2>"
  )
  await source.fill(customised)
  await expect(
    first.window.getByText("Constraints and risks", { exact: true })
  ).toBeVisible()
  await first.window.getByRole("button", { name: "Save template" }).click()
  await expect(first.window.getByRole("button", { name: "Save template" })).toBeDisabled()
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await openSettings(reopened.window)
  await reopened.window.getByRole("button", { name: "Plan", exact: true }).click()
  await expect(reopened.window.getByLabel("Plan template source")).toHaveValue(
    /Constraints and risks/
  )

  await reopened.window.getByRole("button", { name: "Reset default" }).click()
  await reopened.window.getByRole("button", { name: "Save template" }).click()
  await expect(reopened.window.getByLabel("Plan template source")).not.toHaveValue(
    /Constraints and risks/
  )
})

test("the preferred orchestrator persists across restart", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await openSettings(first.window)
  await first.window.getByRole("button", { name: "Plan", exact: true }).click()

  await first.window.getByRole("combobox", { name: "Orchestrator harness" }).click()
  await first.window.getByRole("option", { name: "Codex" }).click()
  await expect
    .poll(() =>
      JSON.parse(
        readFileSync(join(first.home, "jingler", "config.json"), "utf8")
      ).orchestrator
    )
    .toEqual({ cli: "codex", model: "gpt-5.6-sol" })
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await openSettings(reopened.window)
  await reopened.window.getByRole("button", { name: "Plan", exact: true }).click()
  await expect(
    reopened.window.getByRole("combobox", { name: "Orchestrator harness" })
  ).toContainText("Codex")
})

test("comments stay aligned with their highlighted line, escape clipping, and can be deleted", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  await selectText(launched.window, "Implement stages in order")
  await launched.window.getByRole("button", { name: "Comment", exact: true }).click()
  await launched.window
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Keep rollout sequential.")
  await launched.window.getByRole("button", { name: "Send comment" }).click()

  const highlight = launched.window.locator('[data-plan-comment-highlight="a1"]')
  const marker = launched.window.getByRole("button", {
    name: "user annotation, open"
  })
  await expect(highlight).toHaveText("Implement stages in order")
  await expect(marker).toBeVisible()
  const [highlightBox, markerBox] = await Promise.all([
    highlight.boundingBox(),
    marker.boundingBox()
  ])
  expect(highlightBox).not.toBeNull()
  expect(markerBox).not.toBeNull()
  if (highlightBox && markerBox) {
    const highlightedLineCenter = highlightBox.y + Math.min(highlightBox.height, 24) / 2
    const markerCenter = markerBox.y + markerBox.height / 2
    expect(Math.abs(highlightedLineCenter - markerCenter)).toBeLessThan(8)
  }

  await marker.hover()
  const card = launched.window.locator('[data-plan-comment-card="a1"]')
  await expect(card).toContainText("Keep rollout sequential.")
  const cardBounds = await card.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: window.innerWidth,
      height: window.innerHeight
    }
  })
  expect(cardBounds.top).toBeGreaterThanOrEqual(0)
  expect(cardBounds.left).toBeGreaterThanOrEqual(0)
  expect(cardBounds.right).toBeLessThanOrEqual(cardBounds.width)
  expect(cardBounds.bottom).toBeLessThanOrEqual(cardBounds.height)

  await marker.click()
  const deleteComment = card.getByRole("button", { name: "Delete comment" })
  const deleteBounds = await deleteComment.boundingBox()
  expect(deleteBounds).not.toBeNull()
  if (deleteBounds) {
    expect(deleteBounds.x).toBeGreaterThan(cardBounds.right - 48)
    expect(deleteBounds.y).toBeLessThan(cardBounds.top + 40)
  }
  await deleteComment.hover()
  await expect(launched.window.getByTestId("hover-card")).toContainText("Delete comment")
  await expect(card).toBeVisible()
  await deleteComment.click()
  await expect(marker).toHaveCount(0)
  await expect(highlight).toHaveCount(0)
  await expect(launched.window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  await expect.poll(() => readFileSync(currentPlanPath(launched), "utf8")).not.toContain(
    "Keep rollout sequential."
  )
})

test("live edits and conflicts preserve both drafts", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  const file = currentPlanPath(launched)
  await editSource(launched.window, "OPERATOR_MARKER")
  await expect.poll(() => readFileSync(file, "utf8")).toContain("OPERATOR_MARKER")

  // Start a local edit and keep it pending, then land a higher-revision external
  // write before the ~350ms autosave — the machine must surface a conflict that
  // preserves BOTH the local draft and the remote revision, not clobber one.
  const anchor = launched.window.getByText("Implement stages in order").first()
  await anchor.click()
  await launched.window.keyboard.press("End")
  await launched.window.keyboard.type(" LOCAL_DRAFT_SURVIVES")

  const persisted = readFileSync(file, "utf8")
  const revision = revisionOf(file)
  const remote = persisted
    .replace(/^revision:\s*\d+$/m, `revision: ${revision + 1}`)
    .replace("Each stage records", "Remote revision preserved. Each stage records")
  writeFileSync(file, remote)

  await expect(launched.window.getByRole("status")).toContainText("Conflict", {
    timeout: 20_000
  })
  await expect(
    launched.window.getByText("Local draft", { exact: true })
  ).toBeVisible()
  await expect(
    launched.window.getByText(`Remote revision ${revision + 1}`, { exact: true })
  ).toBeVisible()
  await launched.window.getByRole("button", { name: "Keep local and save" }).click()
  await expect(launched.window.getByRole("status")).toContainText("Synced", {
    timeout: 20_000
  })
  await expect.poll(() => readFileSync(file, "utf8")).toContain(
    "LOCAL_DRAFT_SURVIVES"
  )
})

test("approval executes the saved revision and finishes from criterion evidence", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  const exactText = "OPERATOR_APPROVED_REVISION"
  await editSource(launched.window, exactText)
  await launched.window.getByRole("button", {
    name: "Approve and auto",
    exact: true
  }).click()

  await expect(launched.window.getByText("All criteria verified")).toBeVisible({
    timeout: 30_000
  })
  await expect(launched.window.getByText(exactText)).toBeVisible()
  const persisted = readFileSync(currentPlanPath(launched), "utf8")
  expect(persisted).toContain('status: "done"')
  expect(persisted).toContain(exactText)
  expect(persisted).toContain('data-status="passed"')
  await launched.window.getByRole("button", { name: "Conversation" }).first().click()
  await expect(launched.window.getByText("Steps 2, 3 and 5 are done.")).toBeVisible()
  await expect(launched.window.getByText(/PLAN_RESULT/)).toHaveCount(0)
})

test("restart resumes the exact canonical revision", async ({ launchApp }) => {
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(first.window)).toBeVisible()
  await proposePlan(first.window)

  const exactText = "RESTART_SAFE_CRITERION"
  await editSource(first.window, exactText)
  await first.app.close()

  const reopened = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(reopened.window.getByText("stale", { exact: true })).toBeVisible()
  await expect(reopened.window.getByText(exactText).last()).toBeVisible()
  await reopened.window.getByRole("button", { name: "Approve & implement" }).click()
  await reopened.window.getByRole("button", { name: "Conversation" }).first().click()
  expect(readFileSync(currentPlanPath(reopened), "utf8")).toContain(exactText)
  await reopened.window.getByRole("button", { name: /Allow once/ }).click()
  await reopened.window.getByRole("button", { name: "Plan Review" }).first().click()
  await expect(reopened.window.getByText("needs verification", { exact: true })).toBeVisible({
    timeout: 30_000
  })
})

test("a plan diagram renders, and a broken source degrades to an error card", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  // The canned plan ships a valid `data-diagram="mermaid"` block — it renders a
  // themed SVG in the doc, not a raw <pre>.
  await expect(launched.window.locator(".sb-mermaid svg").first()).toBeVisible({
    timeout: 20_000
  })

  // Corrupting the diagram's source (its inline editor) shows an inline error
  // card and does not blank the rest of the document.
  await launched.window.getByLabel("Mermaid diagram source").fill("@@@ not a diagram @@@")
  await expect(launched.window.getByText("Diagram error")).toBeVisible({
    timeout: 20_000
  })
  await expect(launched.window.getByText(/Rollout|Testing|Risks/).first()).toBeVisible()
})

test("inline (WYSIWYG) editing the document persists to the canonical source", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  const file = currentPlanPath(launched)
  const startRevision = revisionOf(file)

  await editSource(launched.window, "INLINE_EDIT_MARKER")

  await expect
    .poll(() => readFileSync(file, "utf8"))
    .toContain("INLINE_EDIT_MARKER")
  expect(revisionOf(file)).toBeGreaterThan(startRevision)
})

test("an external write to the plan file live-updates the open editor (Plan.watch)", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()
  await proposePlan(launched.window)

  const file = currentPlanPath(launched)
  const persisted = readFileSync(file, "utf8")
  const revision = revisionOf(file)
  // No local edits are pending, so a higher-revision external write is adopted
  // (not a conflict) and must appear without the old fixed-interval poll.
  const remote = persisted
    .replace(/^revision:\s*\d+$/m, `revision: ${revision + 1}`)
    .replace("Implement stages in order", "Implement stages in order WATCH_LIVE_UPDATE")
  writeFileSync(file, remote)

  await expect(launched.window.getByText(/WATCH_LIVE_UPDATE/)).toBeVisible({
    timeout: 10_000
  })
})

test("the Plan Review tab is always present and can seed a draft to author", async ({
  launchApp
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()

  // Present with NO plan proposed yet (previously gated on a plan existing).
  const chatContainer = await launched.window.getByTestId("composer").boundingBox()
  expect(chatContainer).not.toBeNull()
  const tab = launched.window.getByRole("button", { name: "Plan Review" }).first()
  await expect(tab).toBeVisible()
  await tab.click()

  // Empty state offers a way to start authoring a plan for the agent.
  await launched.window.getByRole("button", { name: "Start a plan" }).click()

  // A blank draft (from the template) appears in the editable plan document.
  await expect(launched.window.getByLabel("Plan document")).toBeVisible({
    timeout: 20_000
  })
  const planContainer = await launched.window
    .getByTestId("plan-review-container")
    .boundingBox()
  expect(planContainer).not.toBeNull()
  expect(planContainer!.width).toBeCloseTo(chatContainer!.width, 0)
  await expect
    .poll(() => readFileSync(currentPlanPath(launched), "utf8"))
    .toContain('status: "draft"')
  // A draft (no agent run yet) offers a handoff, not the no-op Revise/Approve.
  await expect(
    launched.window.getByRole("button", { name: "Send to agent" })
  ).toBeVisible()
})

test("Claude, Codex, and opencode share native plan mode", async ({ launchApp }) => {
  for (const cli of ["claude", "codex", "opencode"] as const) {
    const launched = await launchApp({
      configured: true,
      withRepo: true,
      sessions: session(cli),
      ...(cli === "opencode" ? { opencode: { providers: [] } } : {})
    })
    await expect(appShell(launched.window)).toBeVisible()
    const composer = launched.window.getByPlaceholder(/Message .+…/)
    await composer.click()
    await launched.window.keyboard.press("Shift+Tab")
    await launched.window.keyboard.press("Shift+Tab")
    await expect(launched.window.locator("[data-mode='plan']")).toBeVisible()
    await composer.fill(`Plan this change with ${cli}.`)
    await composer.press("Enter")
    await expect(
      launched.window.getByRole("button", { name: "Plan Review" }).first()
    ).toBeVisible({ timeout: 20_000 })
    // The Plan Review tab is now always present, so it no longer implies a plan
    // exists — wait for the agent to actually write the canonical file.
    await expect
      .poll(
        () =>
          existsSync(currentPlanPath(launched))
            ? readFileSync(currentPlanPath(launched), "utf8")
            : "",
        { timeout: 20_000 }
      )
      .toContain("jinglerPlan: 1")
    await launched.app.close()
  }
})

test("switching to a Codex model keeps the active plan mode", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session()
  })
  await expect(appShell(launched.window)).toBeVisible()

  const composer = launched.window.getByPlaceholder("Message Claude…")
  await composer.click()
  await launched.window.keyboard.press("Shift+Tab")
  await launched.window.keyboard.press("Shift+Tab")
  const surface = launched.window.locator("[data-mode]").first()
  await expect(surface).toHaveAttribute("data-mode", "plan")

  await launched.window
    .getByRole("button", { name: DEFAULT_CLAUDE_MODEL, exact: true })
    .click()
  await expect(launched.window.getByText("Codex CLI", { exact: true })).toBeVisible()
  await launched.window
    .getByRole("menuitem")
    .filter({ hasText: /^GPT-5\./ })
    .first()
    .click()

  const codexComposer = launched.window.getByPlaceholder("Message Codex…")
  await expect(codexComposer).toBeVisible()
  await expect(surface).toHaveAttribute("data-mode", "plan")

  await codexComposer.fill("Plan this change after switching to Codex.")
  await codexComposer.press("Enter")
  await expect
    .poll(
      () =>
        existsSync(currentPlanPath(launched))
          ? readFileSync(currentPlanPath(launched), "utf8")
          : "",
      { timeout: 20_000 }
    )
    .toContain("jinglerPlan: 1")
})

import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_subagent_view",
  repo: "widget",
  branch: "chore/subagent-view",
  title: "Sub-agent view session",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-26T10:00:00.000Z",
  worktreePath: repoPath,
  mode: "accept-edits"
}]

test("a subagent swaps into the chat lane in place; sibling switch and back keep the main draft", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] survey the app")
  await composer.press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })

  // Main draft typed before the swap must survive the round trip.
  await composer.fill("half-written main draft")
  const groups = window.getByTestId("editor-group")
  const groupCount = await groups.count()
  await expect(window.getByTestId("conversation-scroll")).toHaveCount(1)
  await expect(window.getByTestId("subagent-breadcrumb")).toHaveCount(0)

  await window.getByRole("button", { name: "View", exact: true }).first().click()
  const view = window.getByTestId("fleet-agent-transcript")
  await expect(view).toContainText("Survey the tab bar")
  // Same lane: main transcript is replaced, no editor group appears.
  await expect(window.getByTestId("conversation-scroll")).toHaveCount(0)
  await expect(groups).toHaveCount(groupCount)
  await expect(window.getByTestId("subagent-breadcrumb")).toContainText("survey the app")

  // ▾ switches to the sibling without going back to main.
  await window.getByTestId("subagent-crumb").click()
  await window.getByRole("menuitem", { name: /Audit the theme tokens/ }).click()
  await expect(view).toContainText("Audit the theme tokens")
  await expect(window.getByTestId("subagent-breadcrumb")).toBeVisible()
  await expect(groups).toHaveCount(groupCount)

  // ← Main returns with the draft intact.
  await window.getByTestId("subagent-back").click()
  await expect(window.getByTestId("subagent-breadcrumb")).toHaveCount(0)
  await expect(view).toHaveCount(0)
  await expect(window.getByPlaceholder("Message the agent…")).toHaveValue("half-written main draft")

  // Esc returns too.
  await window.getByTestId("subagent-chip").first().click()
  await window.getByTestId("subagent-chip-popover").getByRole("menuitem", { name: /Survey the tab bar/ }).click()
  await expect(view).toContainText("Survey the tab bar")
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("subagent-breadcrumb")).toHaveCount(0)
  await expect(window.getByPlaceholder("Message the agent…")).toHaveValue("half-written main draft")
  await expect(groups).toHaveCount(groupCount)
})

test("a peer chat is listed in the chip popover and can be messaged from there", async ({ launchApp }) => {
  const stamp = "2026-07-26T10:00:00.000Z"
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: (ctx) => [{
      ...seededSessions(ctx)[0]!,
      id: "s_peer_popover",
      chats: [
        { id: "c_peer_main", title: "Main agent", createdAt: stamp, updatedAt: stamp },
        { id: "c_peer_other", title: "Peer agent", createdAt: stamp, updatedAt: stamp }
      ],
      activeChatId: "c_peer_main"
    }]
  })
  await expect(appShell(window)).toBeVisible()

  // Peers alone are enough for the chip; the old "Peer agents" disclosure is gone.
  await window.getByTestId("subagent-chip").first().click()
  const popover = window.getByTestId("subagent-chip-popover")
  await expect(popover).toContainText("Peers · 1")
  await expect(window.getByText("Peer agents", { exact: true })).toHaveCount(0)

  await popover.getByRole("button", { name: "Message Peer agent" }).click()
  const box = popover.getByRole("textbox", { name: "Message to Peer agent" })
  await box.fill("heads up: touching src/a.ts")
  await box.press("Enter")
  // The idle peer has no live turn to steer, so the send resolves without a delivery:
  // the box re-enables with the draft kept instead of the popover closing or erroring.
  await expect(box).toBeEnabled()
  await expect(box).toHaveValue("heads up: touching src/a.ts")
})

test("Follow in the subagent view opens a file the viewed child edited", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[legacy-agent]] inspect compatibility")
  await composer.press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })
  await window.getByTestId("subagent-chip").first().click()
  await window.getByTestId("subagent-chip-popover").getByRole("menuitem", { name: /Legacy Scout/ }).click()
  await expect(window.getByTestId("fleet-agent-transcript")).toBeVisible()

  // The breadcrumb header carries the same Follow toggle as the composer.
  const follow = window.getByTestId("chat-lane-header").getByTestId("follow-agent-toggle")
  await expect(follow).toHaveAttribute("aria-pressed", "false")
  await follow.click()
  await expect(follow).toHaveAttribute("aria-pressed", "true")
  await expect(window.getByTestId("editor-tab-file-src/delegated.ts").getByRole("tab")).toBeVisible({
    timeout: 15_000
  })
})

test("the subagent view shows the meta strip, Details, the quoted task and a read-only bar with Stop", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[held-subagents]] survey the app")
  await composer.press("Enter")
  await expect(window.getByTestId("subagent-chip").first()).toBeVisible({ timeout: 15_000 })
  await window.getByRole("button", { name: "View", exact: true }).first().click()

  // Strip fields from the fleet node; null fields (phase, cost, artifacts) are omitted.
  const strip = window.getByTestId("subagent-meta-strip")
  await expect(strip.getByTestId("subagent-meta-identity")).toContainText("e2e/pi-fixture:high")
  await expect(strip.getByTestId("subagent-meta-identity")).toContainText("running")
  await expect(strip.getByTestId("subagent-meta-usage")).toContainText("workspace_read_file")
  await expect(strip).not.toContainText("—")

  // Details expands to the key/value grid with run id and started time.
  await expect(window.getByTestId("subagent-meta-details")).toHaveCount(0)
  await strip.getByTestId("subagent-meta-details-toggle").click()
  await expect(window.getByTestId("subagent-meta-details")).toContainText("Run")
  await expect(window.getByTestId("subagent-meta-details")).toContainText("Started")

  // The task leads the transcript as a quote; the composer is replaced by the read-only bar.
  await expect(window.getByTestId("subagent-task")).toContainText("Survey the tab bar")
  const bar = window.getByTestId("subagent-readonly-bar")
  await expect(bar).toContainText("read-only")
  await expect(window.getByPlaceholder("Message the agent…")).toHaveCount(0)

  // Stop goes pending. The held-subagents fixture has no stop responder, so the stopped line
  // is covered by subagent-readonly-bar.test.tsx rather than here.
  await bar.getByRole("button", { name: "Stop" }).click()
  await expect(bar).toContainText("Stopping Explore…")
  await expect(bar.getByRole("button", { name: "Stop" })).toBeDisabled()
})

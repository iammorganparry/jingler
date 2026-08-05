import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * A session opens with only the TAIL of its transcript, and older turns page in
 * on demand.
 *
 * The number that motivated this: a 46MB transcript held whole as a parsed
 * `Message[]` cost hundreds of MB of renderer heap — and the residency cap keeps
 * several live at once, so an install's footprint became a high-water mark of the
 * largest transcripts ever opened. The load now windows to `HISTORY_PAGE_SIZE`
 * (200) messages; "Load earlier" fetches the previous window.
 *
 * Both halves have to hold or the change is a regression rather than a saving:
 * the older turns must NOT be in the payload on open (asserted by their absence),
 * and "Load earlier" must actually reach them (asserted by their arrival). A test
 * that only checked the first would pass on a build that had quietly lost the
 * ability to read history at all.
 */

const TURNS = 250 // > HISTORY_PAGE_SIZE (200), so the tail leaves 50 turns off-screen
const marker = (i: number) => `Seeded turn ${i} of the paging transcript`

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_paging",
    repo: "widget",
    branch: "chore/paging",
    title: "A long conversation",
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

// 250 user turns, oldest first — each carries a unique marker so its presence (or
// absence) on screen pins exactly which window loaded.
const transcripts = {
  c_s_paging_1: Array.from({ length: TURNS }, (_, i) => ({
    id: `u_${i}`,
    role: "user" as const,
    streaming: false,
    createdAt: "2026-07-11T00:00:00.000Z",
    parts: [{ _tag: "Text" as const, text: marker(i) }]
  }))
}

test("a session opens on its tail, and Load earlier pages older turns in", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    transcripts
  })
  await expect(appShell(window)).toBeVisible()

  // The newest turn is on screen — the transcript loaded and autoscrolled to it.
  await expect(window.getByText(marker(TURNS - 1))).toBeVisible({ timeout: 15_000 })

  // The oldest turn is NOT merely virtualized off-screen — it is not in the
  // payload at all (turn 0 is 250 back, past the 200-message tail), so it cannot
  // be reached by scrolling. Absence from the DOM is the whole point of the
  // windowed load.
  await expect(window.getByText(marker(0))).toHaveCount(0)

  // The affordance is offered precisely because older turns remain.
  const loadEarlier = window.getByTestId("load-earlier")
  await expect(loadEarlier).toBeVisible()

  // One more window of 200 covers the remaining 50 turns, so after this the whole
  // transcript is loaded and the button retires itself.
  await loadEarlier.click()
  await expect(window.getByTestId("load-earlier")).toHaveCount(0)

  // The oldest turn is now in hand — bring the top of the list into the virtual
  // window and it renders, proving the page actually reached history.
  await window.getByTestId("conversation-scroll").evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(window.getByText(marker(0))).toBeVisible()
})

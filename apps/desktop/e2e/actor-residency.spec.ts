import { expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Conversation actors are capped in number (`actor-eviction.ts`), so the renderer
 * stops retaining every transcript the operator has ever opened — the retention
 * path behind a renderer measured at a 4.9GB footprint.
 *
 * The cap's whole risk is here, not in the memory it saves: an evicted session has
 * to come back *identical* when the operator returns to it, rebuilt from the
 * transcript on disk. A cap that quietly lost history would be much worse than the
 * leak it fixes, and the failure only shows up after enough sessions to cross the
 * cap — which is exactly the case no one exercises by hand.
 */

const SESSION_COUNT = 9

const seeded = (index: number): SeedSession => ({
  id: `s_res_${index}`,
  repo: "widget",
  branch: `starbase/res-${index}`,
  title: `Residency ${index}`,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: `2026-07-16T00:${String(index).padStart(2, "0")}:00.000Z`
})

/** A one-turn conversation whose text names its session, so a mix-up is visible. */
const conversation = (index: number) => [
  {
    id: `u_s_res_${index}_1`,
    role: "user",
    parts: [{ _tag: "Text", text: `question for session ${index}` }],
    streaming: false,
    createdAt: "2026-07-16T00:00:00.000Z"
  },
  {
    id: `a_s_res_${index}_2`,
    role: "assistant",
    parts: [{ _tag: "Text", text: `answer belonging to session ${index}` }],
    streaming: false,
    createdAt: "2026-07-16T00:00:01.000Z"
  }
]

const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => seeded(i))
const transcripts = Object.fromEntries(
  Array.from({ length: SESSION_COUNT }, (_, i) => [`s_res_${i}`, conversation(i)])
)

test("a session's transcript survives being evicted from the actor cache", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions,
    transcripts
  })

  // Visit every session in turn. Well past the residency cap, so the earliest
  // ones have certainly been stopped and forgotten by the time we reach the end.
  for (let i = 0; i < SESSION_COUNT; i++) {
    await sessionRow(window, `Residency ${i}`).click()
    await expect(window.getByText(`answer belonging to session ${i}`)).toBeAttached()
  }

  // Back to the first, whose actor is long gone: the pane must rebuild it from the
  // transcript on disk, with its own history and nobody else's.
  await sessionRow(window, "Residency 0").click()
  await expect(window.getByText("answer belonging to session 0")).toBeAttached()
  await expect(window.getByText("question for session 0")).toBeAttached()
  await expect(window.getByText("answer belonging to session 8")).not.toBeAttached()
})

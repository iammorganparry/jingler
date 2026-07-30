import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * A transcript's images are fetched per-thumbnail, not shipped with the load.
 *
 * The number that motivated this: across the six largest transcripts on a real
 * install, `Image` parts were 80% of all bytes (98MB of 123MB) and `Text` was
 * 1.5%. A transcript's weight is not its conversation, it is a handful of base64
 * screenshots — and `Sessions.transcriptPage` handed every one of them to the
 * renderer on open, where the conversation actor then held them for as long as
 * it stayed resident.
 *
 * Two halves, and BOTH have to hold or the change is a regression rather than a
 * saving: the payload must not carry the bytes, and the thumbnail must still end
 * up showing the picture. A test that only asserted the first would pass just as
 * happily on a build that had quietly broken every image in the app.
 */

/** A 1x1 red PNG, base64 — small enough to inline, real enough to decode. */
const RED_DOT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_lazy",
    repo: "widget",
    branch: "jingler/lazy-images",
    title: "Look at this screenshot",
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

/** One user turn carrying one image attachment, as `AgentRunner` would persist it. */
const transcripts = {
  c_s_lazy_1: [
    {
      id: "u_1",
      role: "user",
      streaming: false,
      createdAt: "2026-07-11T00:00:00.000Z",
      parts: [
        {
          _tag: "Image",
          attachment: {
            id: "att_red_dot",
            name: "screenshot.png",
            mediaType: "image/png",
            data: RED_DOT
          }
        },
        { _tag: "Text", text: "what is wrong here" }
      ]
    }
  ]
}

test("a transcript's images arrive per-thumbnail, not in the transcript payload", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions,
    transcripts
  })
  await expect(appShell(window)).toBeVisible()

  // The seeded session opens on its own; the title is deliberately NOT used as a
  // locator here — an open session wears it twice (sidebar row and pane header),
  // which is a strict-mode violation rather than a match. See `sessionRow`.
  //
  // The turn being on screen means the transcript really did load, so the
  // assertion below is about what it OMITTED rather than about a screen that
  // never rendered at all.
  await expect(window.getByText("what is wrong here")).toBeVisible({ timeout: 15_000 })

  // The thumbnail resolves. It renders as a placeholder with no `<img>` at all
  // until the bytes arrive, so an `<img>` carrying exactly the seeded base64 is
  // proof that the per-attachment fetch ran, found the image, and handed it over.
  //
  // The other half — that the transcript PAYLOAD omitted those bytes — is not
  // observable from here, because both a stripped payload and an unstripped one
  // end at this same rendered image. It is pinned in `rpc.test.ts` instead,
  // against `withoutAttachmentData` directly. Asserting it loosely here (a brief
  // placeholder, say) would be a race on how fast the fetch resolves, which is a
  // flaky test dressed up as a strict one.
  const thumb = window.getByAltText("screenshot.png")
  await expect(thumb).toBeVisible()
  await expect(thumb).toHaveAttribute("src", `data:image/png;base64,${RED_DOT}`)
})

import {
  DEFAULT_THEMES,
  FileRenderer,
  getHighlighterOptions,
  getSharedHighlighter,
  DEFAULT_RENDER_RANGE
} from "@pierre/diffs"
import { TextDocument } from "@pierre/diffs/edit"
import { expect, it } from "vitest"

/**
 * Pins the pnpm patch on @pierre/diffs 1.3.6 (patches/@pierre__diffs@1.3.6.patch).
 *
 * During an edit session the FileRenderer renders locally. Its async local
 * highlight (`renderFile` → `asyncHighlight().then(...)`) captures the file as
 * it was when the request started; 1.3.6 applies that result unconditionally,
 * so edits that land while a grammar or theme is still loading get their live
 * patched rows replaced by the stale pre-edit rows. The next render then
 * indexes past the stale row array and throws
 * "FileRenderer.processFileResult: Line doesnt exist" — in the app that throw
 * escapes CodeView's render loop (seen via ResizeObserver.handleResize).
 * Upstream guards exactly this staleness on the worker path
 * (`onHighlightSuccess` returns when `editSessionActive`); the patch mirrors
 * the guard on the local path by dropping the result when the render cache is
 * dirty. This test drives the REAL package — it fails on unpatched 1.3.6.
 */

const GROWN_LINES = 40
const grownContents = `${Array.from(
  { length: GROWN_LINES },
  (_, index) => `const line${index} = ${index}`
).join("\n")}\n`

it("keeps edited rows when a stale local highlight resolves mid edit session", async () => {
  // Attach the themes (but NOT the typescript grammar) so the first render
  // takes the synchronous local path and produces a result, while the grammar
  // load runs as the in-flight async highlight the edit must race.
  await getSharedHighlighter(getHighlighterOptions("text", { theme: DEFAULT_THEMES }))

  const file = { name: "grow.ts", contents: "const line0 = 0\n", cacheKey: "rev-1" }
  const renderer = new FileRenderer()
  renderer.beginEditSession()
  const initial = renderer.renderFile(file, {
    ...DEFAULT_RENDER_RANGE,
    startingLine: 0,
    totalLines: 1
  })
  expect(initial?.totalLines).toBeLessThan(GROWN_LINES)

  // The edit lands while the typescript grammar is still loading.
  renderer.applyDocumentChange(new TextDocument("grow.ts", grownContents, "typescript"))

  // Let the pre-edit highlight resolve and (unpatched) clobber the live rows.
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const rendered = renderer.renderFile(undefined, {
    ...DEFAULT_RENDER_RANGE,
    startingLine: 0,
    totalLines: GROWN_LINES
  })
  expect(rendered?.totalLines).toBeGreaterThanOrEqual(GROWN_LINES)
  expect(rendered?.rowCount).toBeGreaterThanOrEqual(GROWN_LINES)
})

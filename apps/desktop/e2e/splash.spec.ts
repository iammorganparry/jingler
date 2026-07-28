import { expect, test } from "./fixtures.js"

/**
 * The launch splash: does the brand mark actually ANIMATE?
 *
 * This is the one screen with no second chance. It is on for a couple of seconds
 * at most, it is the first thing an operator sees, and every way it can fail
 * fails QUIETLY — the shader paints its own `colorBack` over the whole window
 * when it has no texture, and the page behind it is painted the same colour on
 * purpose, so "the animation is running" and "the animation never started" are
 * the same black rectangle. Nothing throws. Nothing logs.
 *
 * It shipped broken exactly that way: the static fallback flashed at viewport
 * size for a frame, then the shader mounted and drew nothing anyone ever saw,
 * because the splash unmounted before it had drawn. So these assert the two
 * halves separately — which branch mounted, and whether it put pixels on screen.
 */

/** The splash's own test id, and the brand element's branch marker. */
const brandBranch = (window: import("@playwright/test").Page) =>
  window.locator("[data-jingler-brand]")

test("the splash renders the animated mark, not the static fallback", async ({
  launchApp
}) => {
  const { window } = await launchApp()

  // The splash is up first — assert against it before anything else can settle.
  await expect(window.getByTestId("loading-screen")).toBeVisible()

  const brand = brandBranch(window)
  await expect(brand).toBeVisible()

  // `pending` is the pre-probe state and must never be what the operator sees
  // for any length of time; `static` means WebGL was unavailable, which on a dev
  // machine means something regressed rather than that the machine is limited.
  await expect(brand).toHaveAttribute("data-jingler-brand", /^(dark|light)$/)

  // The shader mounts a real canvas. A missing one means the Heatmap bailed.
  await expect(window.locator("canvas")).toHaveCount(1)
})

/**
 * The shader's source image must actually LOAD.
 *
 * This is the regression that shipped, and it is worth stating exactly, because
 * the obvious test for it does not work. Reading the canvas back — `drawImage`
 * into a 2D context, look for a non-uniform pixel — returns blank whether the
 * shader drew or not: a WebGL context without `preserveDrawingBuffer` has its
 * buffer cleared at composite, so the readback is empty by specification and the
 * assertion fails on a perfectly working splash.
 *
 * So this asserts the CAUSE instead. The mark is fed to the shader by rasterising
 * it to a canvas, calling `toBlob`, and loading the result back through an `<img>`
 * — and the renderer's `img-src` did not allow `blob:`. Chromium blocked the load,
 * the shader logged "Could not set uniforms", and the splash painted its
 * background colour over the whole window. Nothing threw. The page was the same
 * colour by design, so a blocked texture and a running animation were the same
 * black rectangle.
 *
 * A console with no CSP violation and no uniform failure is the strongest signal
 * available here that is not itself a lie.
 */
test("the splash's shader loads its texture — no CSP violation, no uniform failure", async ({
  launchApp
}) => {
  const { window } = await launchApp()

  const errors: string[] = []
  window.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })

  await expect(window.getByTestId("loading-screen")).toBeVisible()
  // Long enough for the image to rasterise, blob, reload and reach the shader.
  await window.waitForTimeout(2000)

  const blocked = errors.filter(
    (text) => /Content Security Policy/i.test(text) || /Could not set uniforms/i.test(text)
  )
  expect(blocked).toStrictEqual([])
})

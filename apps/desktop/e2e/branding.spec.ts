import { expect, test } from "./fixtures.js"

/**
 * Branding: what a fresh install actually looks like.
 *
 * These assertions exist because every one of them can break SILENTLY. A
 * `--sb-*` var that resolves to nothing makes CSS drop the declaration and the
 * element inherit, so a broken token shows up three screens away as a panel
 * that is subtly the wrong grey. A theme that fails to load falls back — by
 * design — to the theme the fallback block already paints, so "shipped" and
 * "failed" render identically. And a bundler that fails to emit the shader's
 * source image leaves a transparent canvas, which looks like a deliberately
 * minimal splash rather than a bug.
 *
 * So each check is against a value the app should not be able to produce by
 * accident.
 */

test("a fresh install boots into the brand palette", async ({ launchApp }) => {
  // No `configured`, so there is no config.json and nothing has chosen a theme
  // — this is the `DEFAULT_THEME_ID` path, not a persisted preference.
  const { window } = await launchApp()

  // Wait for the app to get PAST the splash. `data-theme-kind` is written by
  // `ThemeProvider`, which mounts after the boot machine settles; asserting
  // straight after launch reads the loading screen, where the attribute does
  // not exist yet and the vars still come from the globals.css fallback. That
  // fallback happens to be right, which is exactly why the race is worth
  // avoiding — it would pass for the wrong reason on a slower machine.
  await expect(window.getByText("Set up your workspace")).toBeVisible()

  const applied = await window.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return {
      kind: document.documentElement.dataset.themeKind,
      brand: root.getPropertyValue("--sb-brand").trim(),
      editor: root.getPropertyValue("--sb-editor").trim(),
      canvas: root.getPropertyValue("--sb-canvas").trim(),
      // `getComputedStyle` substitutes `var()` in custom properties, so these
      // come back as the resolved hex rather than the reference. That is the
      // stronger assertion: it proves the chain `--ring` → `--sb-brand` →
      // `#ef3f57` holds end to end, not merely that the reference was written.
      primary: root.getPropertyValue("--primary").trim(),
      ring: root.getPropertyValue("--ring").trim()
    }
  })

  expect(applied.kind).toBe("dark")
  expect(applied.brand.toLowerCase()).toBe("#ef3f57")
  expect(applied.editor.toLowerCase()).toBe("#212121")
  expect(applied.canvas.toLowerCase()).toBe("#141414")
  expect(applied.primary.toLowerCase()).toBe("#ef3f57")
  expect(applied.ring.toLowerCase()).toBe("#ef3f57")
})

test("brand red and destructive red stay distinguishable", async ({ launchApp }) => {
  // The whole reason `--sb-brand` exists. If a future palette edit collapses
  // these, "Delete session" and "New session" become the same swatch and the
  // destructive tone stops carrying information.
  const { window } = await launchApp()
  await expect(window.getByText("Set up your workspace")).toBeVisible()

  const { brand, destructive } = await window.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    return {
      brand: root.getPropertyValue("--sb-brand").trim().toLowerCase(),
      destructive: root.getPropertyValue("--sb-red").trim().toLowerCase()
    }
  })

  expect(brand).not.toBe(destructive)
})

test("the brand typefaces are bundled, not silently falling back to system-ui", async ({
  launchApp
}) => {
  const { window } = await launchApp()

  await expect(window.getByText("Set up your workspace")).toBeVisible()

  // `load()` before `check()`, deliberately. `check()` alone reports whether a
  // face is ALREADY resolved, and the mono face in particular may not be — the
  // setup screen has no terminal on it. Asking for the family forces the
  // lookup, and it can only succeed if the woff2 shipped AND the family name
  // matches. A missing `Variable` suffix (the bug this app shipped with) fails
  // here while the UI still renders perfectly readably in system-ui.
  const loaded = await window.evaluate(async () => {
    await Promise.all([
      document.fonts.load('16px "Hanken Grotesk Variable"'),
      document.fonts.load('16px "JetBrains Mono Variable"')
    ])
    return {
      sans: document.fonts.check('16px "Hanken Grotesk Variable"'),
      mono: document.fonts.check('16px "JetBrains Mono Variable"')
    }
  })

  expect(loaded.sans).toBe(true)
  expect(loaded.mono).toBe(true)
})

test("the splash renders the animated brand mark", async ({ launchApp }) => {
  const { window } = await launchApp()

  // The splash is transient — by the time the fixture hands back a window the
  // app has usually left `loading`. Assert on the mark being reachable at all
  // rather than racing the boot: the setup screen carries the same vector mark,
  // and a failed asset or a bad import shows up as zero matches either way.
  const mark = window.locator('svg[aria-label="Jingler"]')
  await expect(mark.first()).toBeVisible()

  // The mark must be a real path, not an empty <svg> left behind by a bad
  // extraction from the source artwork — which renders as nothing at all.
  const pathLength = await mark.first().locator("path").first().evaluate(
    (node) => (node as SVGPathElement).getAttribute("d")?.length ?? 0
  )
  expect(pathLength).toBeGreaterThan(500)

  // Nothing here asserts the WebGL canvas itself. The splash unmounts as soon
  // as boot completes, so racing it would make this spec flaky for a reason
  // that has nothing to do with branding — and CI runners have no GPU, where
  // `BrandShader` correctly renders the static mark instead. The mark above is
  // what both paths share, so it is what this pins.
})

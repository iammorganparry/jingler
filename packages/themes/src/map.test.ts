import { describe, expect, it } from "vitest"
import type { VsCodeTheme } from "@jingler/core"
import { contrast, luminance, parseHex } from "./color.js"
import { toTokens } from "./map.js"
import { BUILTIN_THEMES } from "./presets/index.js"

const rgba = (hex: string) => parseHex(hex)!
const ratio = (a: string, b: string) => contrast(rgba(a), rgba(b))
const lum = (hex: string) => luminance(rgba(hex))

const ACCENTS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange"] as const

describe("toTokens — every built-in theme", () => {
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s resolves every token",
    (_id, theme) => {
      const tokens = toTokens(theme)
      const empty = Object.entries(tokens).filter(([, v]) => v === undefined || v === null || v === "")
      expect(empty).toEqual([])
    }
  )

  /**
   * Body text is the app's floor. A theme that applies but whose sidebar text
   * sits at 3:1 is worse than one that fails to load, because the operator
   * blames their eyes rather than the theme.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps body text readable on the panel",
    (_id, theme) => {
      const t = toTokens(theme)
      expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
    }
  )

  /**
   * Accents are chips, dots and one-word labels — the non-text 3:1 bar, not
   * body text's 4.5. Without the check, Solarized Light's ANSI yellow lands at
   * roughly 2:1 as UI text on a cream panel.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps every accent distinguishable on the panel",
    (_id, theme) => {
      const t = toTokens(theme)
      for (const accent of ACCENTS) {
        expect(ratio(t[accent], t.panel), `${accent} on panel`).toBeGreaterThanOrEqual(3)
      }
    }
  )

  /**
   * The five text tones are the type hierarchy, and Jingler renders all of
   * them inside a single sidebar row.
   *
   * Non-increasing rather than strictly decreasing, because the top of the ramp
   * legitimately saturates: High Contrast Dark and Tomorrow Night Blue both put
   * body text at `#ffffff`, and there is nothing brighter for a heading to be.
   * Manufacturing a step there would mean dimming body text below the theme's
   * own choice — on a HIGH CONTRAST theme, which is the one place that would be
   * indefensible.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s never inverts the text ramp",
    (_id, theme) => {
      const t = toTokens(theme)
      const ratios = [t.textBright, t.textBody, t.text, t.muted, t.dim].map((c) => ratio(c, t.panel))
      for (let i = 1; i < ratios.length; i++) {
        expect(ratios[i]!, `tone ${i} vs ${i - 1}`).toBeLessThanOrEqual(ratios[i - 1]!)
      }
    }
  )

  /**
   * The BOTTOM of the ramp has headroom on every theme — there is always room
   * between body text and the background — so a collapse there is a real
   * defect, not saturation. Light Modern gives `foreground` and
   * `descriptionForeground` the same `#3b3b3b`, which without the ramp pass
   * makes a timestamp indistinguishable from the label above it.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps secondary and tertiary text strictly quieter than body text",
    (_id, theme) => {
      const t = toTokens(theme)
      const body = ratio(t.text, t.panel)
      expect(ratio(t.muted, t.panel), "muted vs text").toBeLessThan(body)
      expect(ratio(t.dim, t.panel), "dim vs muted").toBeLessThan(ratio(t.muted, t.panel))
    }
  )

  /**
   * `sunken` is a WELL — terminals and code blocks are rendered into it, inside
   * panels and inside editor-backed prose. Monokai puts its selection colour
   * `#414339` in `panel.background`, so read literally the well came out
   * lighter than the panel containing it and code blocks appeared to bulge out
   * of the card rather than sink into it.
   */
  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s recesses the well below both surfaces it appears in",
    (_id, theme) => {
      const t = toTokens(theme)
      if (t.kind === "high-contrast") return // flat by design; borders carry it
      expect(lum(t.sunken), "sunken vs panel").toBeLessThan(lum(t.panel))
      expect(lum(t.sunken), "sunken vs editor").toBeLessThan(lum(t.editor))
    }
  )

  it.each(BUILTIN_THEMES.map((b) => [b.id, b.theme] as const))(
    "%s keeps canvas behind the panel and the panel at or behind the editor",
    (_id, theme) => {
      const t = toTokens(theme)
      if (t.kind === "high-contrast") return
      expect(lum(t.canvas)).toBeLessThan(lum(t.panel))
      expect(lum(t.panel)).toBeLessThan(lum(t.editor))
    }
  )

  it("labels each theme with the right ground", () => {
    const byId = Object.fromEntries(BUILTIN_THEMES.map((b) => [b.id, toTokens(b.theme).kind]))
    expect(byId["one-dark-pro"]).toBe("dark")
    expect(byId["light-modern"]).toBe("light")
    expect(byId["solarized-light"]).toBe("light")
    expect(byId["high-contrast-dark"]).toBe("high-contrast")
  })
})

/**
 * Jingler Dark is `DEFAULT_THEME_ID`: a fresh install runs it, every config
 * without a saved theme resolves to it, and every failure falls back to it. If
 * the fold moved a single value, then "theming shipped" and "the theme failed
 * to load" would both look like the app quietly changing colour — and every
 * Storybook baseline would need rebuilding for a feature meant to be a no-op by
 * default. These are the literal values in `packages/ui/src/globals.css`.
 *
 * Half of them are NOT stated by the preset. `sunken` comes out of
 * `enforceSurfaceRamp` (the theme's own `panel.background` sits too close to
 * `sideBar.background` to read as a separate plane), and the accents pass
 * through the contrast bar. That is exactly why this is pinned rather than
 * eyeballed: those are the values a hand-written `:root` block would get wrong.
 */
describe("toTokens — Jingler Dark is a visual no-op", () => {
  const t = toTokens(BUILTIN_THEMES.find((b) => b.id === "jingler-dark")!.theme)

  it.each([
    ["canvas", "#141414"],
    ["panel", "#1b1b1b"],
    ["sunken", "#171717"],
    ["editor", "#212121"],
    ["surface", "#2b2b2b"],
    ["hairline", "#0f0f0f"],
    ["line", "#333333"],
    ["lineStrong", "#454545"],
    ["textBright", "#f4f1f1"],
    ["textBody", "#dedada"],
    ["text", "#c6c1c1"],
    ["muted", "#8d8686"],
    ["dim", "#6a6363"],
    ["blue", "#6faef6"],
    ["green", "#70d294"],
    ["yellow", "#ebcb60"],
    ["red", "#ee8372"],
    ["purple", "#db91ed"],
    ["cyan", "#5eccd4"],
    ["orange", "#f1a35f"],
    // Brand red, and NOT `red` — the two are neighbours on purpose. If these
    // ever fold to the same value, `--primary` and `--destructive` have
    // collapsed and a delete button is indistinguishable from a create one.
    ["brand", "#ef3f57"],
    ["brandHover", "#f5687b"]
  ] as const)("%s is exactly %s", (token, expected) => {
    expect(t[token].toLowerCase()).toBe(expected)
  })

  /**
   * The diff viewer is the loudest place the no-op rule could break — a wash
   * that shifts recolours every line of every review at once. The preset states
   * both washes outright rather than letting them be derived, so this pins the
   * derived alpha alongside the stated hue.
   */
  it("keeps the diff washes on the app's green and red", () => {
    expect(t.diffAddBg).toContain("112 210 148") // green
    expect(t.diffDelBg).toContain("238 131 114") // red
    expect(t.diffAddBg).toMatch(/0\.12\d?|0\.13/)
    expect(t.diffDelBg).toMatch(/0\.12\d?|0\.13/)
  })

  /** The gutter markers are deliberately quiet, so they skip the accent bar. */
  it("keeps the dim gutter markers rather than brightening them to pass contrast", () => {
    expect(t.diffAddFg.toLowerCase()).toBe("#447e59")
    expect(t.diffDelFg.toLowerCase()).toBe("#855047")
  })

  it.each([
    ["scrollbar", "rgb(255 255 255 / 0.125)"],
    ["scrollbarHover", "rgb(255 255 255 / 0.2)"],
    ["selection", "rgb(239 63 87 / 0.22)"]
  ] as const)("%s matches the value already in globals.css", (token, expected) => {
    expect(t[token]).toBe(expected)
  })

  it("links hover to the brand's lifted tone, matching --sb-link-hover", () => {
    expect(t.linkHover.toLowerCase()).toBe("#f5687b")
  })

  /**
   * The accents were retuned to share the brand's saturation/lightness
   * envelope, which is what makes them read as one family rather than seven
   * separately-chosen colours. A future edit that drops one back to a stock
   * VS Code hex would pass every other assertion here — the value would still
   * be a valid colour with fine contrast — and only show up as the palette
   * quietly looking unrelated to itself again.
   */
  it("keeps every accent inside the brand's saturation and lightness envelope", () => {
    const hsl = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      const max = Math.max(r!, g!, b!)
      const min = Math.min(r!, g!, b!)
      const l = (max + min) / 2
      const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
      return { s: s * 100, l: l * 100 }
    }

    for (const token of ["blue", "green", "yellow", "red", "purple", "cyan", "orange"] as const) {
      const { s, l } = hsl(t[token])
      expect.soft(s, `${token} saturation`).toBeGreaterThanOrEqual(50)
      expect.soft(s, `${token} saturation`).toBeLessThanOrEqual(90)
      expect.soft(l, `${token} lightness`).toBeGreaterThanOrEqual(58)
      expect.soft(l, `${token} lightness`).toBeLessThanOrEqual(78)
    }
  })
})

describe("toTokens — sparse themes", () => {
  /**
   * High Contrast Dark, the sparsest theme we ship, sets eleven colours. Every
   * panel, border, accent and ANSI slot has to be produced from those — so this
   * is the case that proves the fallback chains carry a theme rather than
   * merely decorating one.
   */
  it("builds a full, ordered token set from only editor.background", () => {
    const sparse: VsCodeTheme = {
      name: "Sparse Dark",
      type: "dark",
      colors: { "editor.background": "#101014" }
    }
    const t = toTokens(sparse)

    expect(t.editor.toLowerCase()).toBe("#101014")
    expect(Object.values(t).every(Boolean)).toBe(true)
    expect(t.panel).not.toBe(t.editor)
    expect(t.sunken).not.toBe(t.panel)
    expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
  })

  it("builds a legible light theme from only editor.background", () => {
    const t = toTokens({ name: "Sparse Light", type: "light", colors: { "editor.background": "#ffffff" } })

    expect(t.kind).toBe("light")
    expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
    // On a light ground there is no white left to climb, so raised chrome has
    // to get DARKER. A hover state lighter than #ffffff is not available.
    expect(lum(t.surface)).toBeLessThan(lum(t.editor))
  })

  it("falls back entirely when a theme names no colours at all", () => {
    const t = toTokens({ name: "Empty", type: "dark" })
    expect(t.editor.toLowerCase()).toBe("#282c34")
    expect(Object.values(t).every(Boolean)).toBe(true)
  })
})

describe("toTokens — translucent values", () => {
  /**
   * VS Code themes give alpha freely — `descriptionForeground: "#ccccccb3"` is
   * ordinary. A translucent value assigned to a var that paints a SURFACE means
   * the desktop shows through, because the Electron window is frameless.
   */
  it("flattens a translucent sidebar onto an opaque surface", () => {
    const t = toTokens({
      name: "Translucent",
      type: "dark",
      colors: { "editor.background": "#202020", "sideBar.background": "#ffffff20" }
    })
    expect(t.panel).toMatch(/^#[0-9a-f]{6}$/i)
    expect(t.panel).not.toContain("rgb")
  })

  /**
   * Washes are the opposite case: hover and selection sit over an unknown
   * surface, so baking them opaque would make every hovered row the wrong
   * colour on the surfaces they were not baked against.
   */
  it("keeps hover and overlay translucent", () => {
    const t = toTokens(BUILTIN_THEMES[0]!.theme)
    expect(t.hover).toContain("rgb")
    expect(t.overlay).toContain("rgb")
  })
})

/**
 * Themes are user-supplied files that people download and share, and every
 * token ends up interpolated into `:root { --sb-x: <value>; }` — text that is
 * additionally injected into a `<style>` before React mounts so the first
 * paint is themed.
 *
 * So a theme is untrusted input on a path to a stylesheet. The mapper's defence
 * is that it never passes a theme's string through: every token is re-emitted
 * from parsed components. These tests pin that, keyed on the four tokens that
 * legitimately keep their alpha and so used to read the raw string.
 */
describe("toTokens — a theme is untrusted input", () => {
  const HOSTILE = "red } * { display: none } :root { --sb-panel: red"

  it.each([
    ["scrollbarSlider.background", "scrollbar"],
    ["scrollbarSlider.hoverBackground", "scrollbarHover"],
    ["diffEditor.insertedTextBackground", "diffAddBg"],
    ["diffEditor.removedTextBackground", "diffDelBg"],
    ["terminal.selectionBackground", null],
    ["editor.selectionBackground", "selection"]
  ] as const)("never lets %s escape into the stylesheet", (key, token) => {
    const t = toTokens({
      name: "Hostile",
      type: "dark",
      colors: { "editor.background": "#101010", [key]: HOSTILE }
    })
    const values = [...Object.values(t).filter((v) => typeof v === "string"), ...Object.values(t.terminal)]
    for (const value of values) {
      expect(value).not.toContain("}")
      expect(value).not.toContain("<")
      expect(value).not.toContain(";")
    }
    if (token) expect(t[token]).not.toContain("display")
  })

  it("falls back to a derived wash when the theme's value is unparseable", () => {
    const t = toTokens({
      name: "Junk",
      type: "dark",
      colors: { "editor.background": "#101010", "scrollbarSlider.background": "not-a-colour" }
    })
    expect(t.scrollbar).toMatch(/^(#[0-9a-f]{6}|rgb\()/i)
  })

  /**
   * The alpha is the whole reason these four read the theme's own value rather
   * than a derived one, so laundering must not flatten it.
   */
  it("keeps the theme's alpha on a translucent wash", () => {
    const t = toTokens({
      name: "Alpha",
      type: "dark",
      colors: { "editor.background": "#101010", "diffEditor.insertedTextBackground": "#9bb95533" }
    })
    expect(t.diffAddBg).toContain("rgb(")
    expect(t.diffAddBg).toContain("0.2")
  })
})

describe("toTokens — colour customizations", () => {
  /**
   * Overrides are merged into `colors` before the fold, not patched onto the
   * output, so they are written in VS Code's vocabulary and stay portable —
   * which is also what lets one override survive switching themes.
   */
  it("applies an override in the theme's own vocabulary", () => {
    const base = toTokens(BUILTIN_THEMES[0]!.theme)
    const overridden = toTokens(BUILTIN_THEMES[0]!.theme, { "editor.background": "#123456" })

    expect(base.editor.toLowerCase()).not.toBe("#123456")
    expect(overridden.editor.toLowerCase()).toBe("#123456")
  })

  it("still enforces the ramps over an override", () => {
    const t = toTokens(BUILTIN_THEMES[0]!.theme, { "sideBar.background": "#ffffff" })
    // A white sidebar on a dark theme is legal input; the text on it must still
    // be readable rather than the theme's original light-on-dark grey.
    expect(ratio(t.text, t.panel)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("toTokens — terminal palette", () => {
  /**
   * Where a theme states `terminal.ansi*` we pass it through untouched, even
   * when it would fail the accent contrast bar. The author chose these for
   * exactly this use, and "correcting" them means `ls` and `git diff` stop
   * looking like they do in VS Code.
   */
  it("passes a theme's ANSI colours through verbatim", () => {
    const t = toTokens({
      name: "Ansi",
      type: "dark",
      colors: { "editor.background": "#101010", "terminal.ansiRed": "#800000" }
    })
    expect(t.terminal.red.toLowerCase()).toBe("#800000")
  })

  it("fills every ANSI slot even when a theme names none", () => {
    const t = toTokens({ name: "No Ansi", type: "dark", colors: { "editor.background": "#101010" } })
    expect(Object.values(t.terminal).every((v) => typeof v === "string" && v.length > 0)).toBe(true)
  })

  /**
   * The terminal dock is painted on `sunken`. Backing the canvas with `editor`
   * instead would make the terminal look like it floats in front of the panel
   * it lives in.
   */
  it("backs the terminal onto the recessed well, not the editor", () => {
    const t = toTokens({ name: "Plain", type: "dark", colors: { "editor.background": "#101010" } })
    expect(t.terminal.background.toLowerCase()).toBe(t.sunken.toLowerCase())
  })
})

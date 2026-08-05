import { cleanup, render, screen } from "@testing-library/react"
import type { VsCodeTheme } from "@jingler/core"
import {
  getResolvedOrResolveTheme,
  type ThemeRegistrationResolved
} from "@pierre/diffs"
import {
  jinglerDark,
  jinglerLight,
  toTokens
} from "@jingler/themes"
import { afterEach, describe, expect, it } from "vitest"
import { PierreProvider, usePierreRenderer } from "./pierre-provider.js"
import {
  createPierreThemeAdapter,
  PIERRE_DIFF_TOKEN_CSS,
  PIERRE_TREE_TOKEN_STYLES
} from "./pierre-theme.js"

afterEach(cleanup)

const resolvedTheme = async (name: string): Promise<ThemeRegistrationResolved> =>
  Promise.resolve(getResolvedOrResolveTheme(name))

describe("Pierre theme adapter", () => {
  it("registers built-in dark and light themes with Jingler syntax grounds", async () => {
    const darkTokens = toTokens(jinglerDark)
    const lightTokens = toTokens(jinglerLight)
    const dark = createPierreThemeAdapter(jinglerDark, darkTokens)
    const light = createPierreThemeAdapter(jinglerLight, lightTokens)

    expect(dark.themeType).toBe("dark")
    expect(light.themeType).toBe("light")
    expect(light.diffTheme).not.toBe(dark.diffTheme)
    await expect(resolvedTheme(dark.diffTheme)).resolves.toMatchObject({
      name: dark.diffTheme,
      bg: darkTokens.sunken,
      fg: darkTokens.textBody
    })
    await expect(resolvedTheme(light.diffTheme)).resolves.toMatchObject({
      name: light.diffTheme,
      bg: lightTokens.sunken,
      fg: lightTokens.textBody
    })
  })

  it("fingerprints edited user themes and retains their token rules", async () => {
    const tokens = toTokens(jinglerDark)
    const custom: VsCodeTheme = {
      name: "Operator theme",
      type: "dark",
      colors: {
        "editor.background": "#101214",
        "editor.foreground": "#f4f5f6"
      },
      tokenColors: [
        { scope: ["keyword.control"], settings: { foreground: "#abcdef" } }
      ]
    }
    const first = createPierreThemeAdapter(custom, tokens)
    const edited = createPierreThemeAdapter(
      {
        ...custom,
        tokenColors: [
          { scope: ["keyword.control"], settings: { foreground: "#fedcba" } }
        ]
      },
      tokens
    )

    expect(edited.diffTheme).not.toBe(first.diffTheme)
    const resolved = await resolvedTheme(first.diffTheme)
    expect(JSON.stringify(resolved)).toContain("abcdef")
  })

  it("maps every shadow-root styling hook back to live --sb-* tokens", () => {
    const adapter = createPierreThemeAdapter(null, toTokens(jinglerLight))

    expect(adapter.unsafeDiffCSS).toBe(PIERRE_DIFF_TOKEN_CSS)
    expect(adapter.unsafeDiffCSS).toContain("var(--sb-editor)")
    expect(adapter.unsafeDiffCSS).toContain("var(--sb-diff-add-bg)")
    expect(adapter.treeStyles).toMatchObject(PIERRE_TREE_TOKEN_STYLES)
    for (const value of Object.values(PIERRE_TREE_TOKEN_STYLES)) {
      expect(value).toMatch(/^var\(--(?:sb-|font-)/)
    }
  })

  it("updates mounted consumers when the active theme changes", () => {
    function Probe() {
      const renderer = usePierreRenderer()
      return (
        <output data-testid="pierre-theme">
          {renderer.theme.themeType}:{renderer.theme.diffTheme}
        </output>
      )
    }

    const view = render(
      <PierreProvider theme={jinglerDark} tokens={toTokens(jinglerDark)} workers={false}>
        <Probe />
      </PierreProvider>
    )
    const dark = screen.getByTestId("pierre-theme").textContent
    expect(dark).toMatch(/^dark:/)

    view.rerender(
      <PierreProvider theme={jinglerLight} tokens={toTokens(jinglerLight)} workers={false}>
        <Probe />
      </PierreProvider>
    )
    expect(screen.getByTestId("pierre-theme").textContent).toMatch(/^light:/)
    expect(screen.getByTestId("pierre-theme").textContent).not.toBe(dark)
  })
})

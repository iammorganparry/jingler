import { cleanup, render, screen, waitFor } from "@testing-library/react"
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parsePierreFileDiffs } from "./parse.js"
import {
  PierreFileDiffView,
  PierreProvider,
  usePierreRenderer
} from "./pierre-provider.js"
import {
  createPierreThemeAdapter,
  JINGLER_PIERRE_VISUAL_CONTRACT,
  PIERRE_DIFF_TOKEN_CSS,
  PIERRE_HOST_CLASS,
  PIERRE_TREE_TOKEN_STYLES
} from "./pierre-theme.js"

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const resolvedTheme = async (name: string): Promise<ThemeRegistrationResolved> =>
  Promise.resolve(getResolvedOrResolveTheme(name))

const THEME_TOKEN_PATTERN = /^var\(--(?:sb-|font-)/
const CSS_LITERAL_COLOUR_PATTERN = /#[\da-f]{3,8}\b|\brgba?\(/i
const DARK_THEME_PATTERN = /^dark:/
const LIGHT_THEME_PATTERN = /^light:/

describe("Pierre theme adapter", () => {
  it("keeps the legacy diff skin legible in dark and light themes", async () => {
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

  it("maps the legacy diff skin entirely through Jingler theme tokens", () => {
    const adapter = createPierreThemeAdapter(null, toTokens(jinglerLight))

    expect(adapter.unsafeDiffCSS).toBe(PIERRE_DIFF_TOKEN_CSS)
    expect(adapter.unsafeDiffCSS).toContain("var(--sb-editor)")
    expect(adapter.unsafeDiffCSS).toContain("var(--sb-diff-add-bg)")
    expect(adapter.treeStyles).toMatchObject(PIERRE_TREE_TOKEN_STYLES)
    expect(PIERRE_TREE_TOKEN_STYLES["--trees-indent-guide-bg-override"]).toBe(
      "var(--sb-border)"
    )
    for (const value of Object.values(PIERRE_TREE_TOKEN_STYLES)) {
      expect(value).toMatch(THEME_TOKEN_PATTERN)
    }
    expect(adapter.unsafeDiffCSS).not.toMatch(CSS_LITERAL_COLOUR_PATTERN)
  })

  it("restores the legacy Jingler diff typography spacing gutters and add-remove palette on Pierre", () => {
    const adapter = createPierreThemeAdapter(null, toTokens(jinglerLight))

    expect(adapter.unsafeDiffCSS).toContain("var(--sb-diff-add-bg)")
    expect(adapter.unsafeDiffCSS).toContain("var(--sb-diff-del-bg)")
    expect(adapter.unsafeDiffCSS).toContain("--diffs-font-size: calc(11px")
    expect(adapter.unsafeDiffCSS).toContain("min-height: calc(21px")
    expect(adapter.unsafeDiffCSS).toContain("height: 34px")
    expect(adapter.unsafeDiffCSS).toContain("height: 26px")
    expect(adapter.unsafeDiffCSS).toContain("grid-template-columns: repeat(2, 40px)")
  })

  it("matches every unsafe selector against Pierre's rendered beta structure", async () => {
    const patch = [
      "diff --git a/src/contract.ts b/src/contract.ts",
      "--- a/src/contract.ts",
      "+++ b/src/contract.ts",
      "@@ -1,3 +1,3 @@",
      "-export const first = oldValue",
      "+export const first = nextValue",
      " export const second = stableValue",
      " export const third = stableValue",
      "@@ -28,3 +28,3 @@",
      " export const beforeLast = stableValue",
      "-export const last = oldValue",
      "+export const last = nextValue",
      " export const eof = true",
      ""
    ].join("\n")
    const fileDiff = parsePierreFileDiffs(patch)[0]!
    const view = render(
      <PierreProvider
        theme={jinglerDark}
        tokens={toTokens(jinglerDark)}
        workers={false}
      >
        <PierreFileDiffView
          label="Pierre selector contract"
          fileDiff={fileDiff}
          selection={{
            path: fileDiff.name,
            side: "new",
            startLine: 1,
            endSide: "new",
            endLine: 1
          }}
          onSelectionChange={() => {}}
          options={{ diffStyle: "unified", hunkSeparators: "line-info" }}
        />
      </PierreProvider>
    )

    expect(view.container.firstElementChild?.classList).toContain(
      PIERRE_HOST_CLASS
    )
    const root = await waitFor(() => {
      const container = view.container.querySelector("diffs-container")
      expect(container?.shadowRoot).toBeTruthy()
      return container!.shadowRoot!
    })

    for (const [name, selector] of Object.entries(
      JINGLER_PIERRE_VISUAL_CONTRACT.selectors
    )) {
      await waitFor(() => {
        expect(
          root.querySelector(selector),
          `Pierre selector contract lost ${name}: ${selector}`
        ).toBeTruthy()
      })
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
    expect(dark).toMatch(DARK_THEME_PATTERN)

    view.rerender(
      <PierreProvider theme={jinglerLight} tokens={toTokens(jinglerLight)} workers={false}>
        <Probe />
      </PierreProvider>
    )
    expect(screen.getByTestId("pierre-theme").textContent).toMatch(LIGHT_THEME_PATTERN)
    expect(screen.getByTestId("pierre-theme").textContent).not.toBe(dark)
  })
})

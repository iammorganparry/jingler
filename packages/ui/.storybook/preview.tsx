import { createElement } from "react"
import type { Preview } from "@storybook/react-vite"
import { MotionConfig } from "motion/react"
import { BUILTIN_THEMES, toTokens } from "@jingler/themes"
import { ThemeProvider } from "../src/theme-provider.js"
import "../src/globals.css"

/**
 * Every built-in, folded once at module load.
 *
 * `toTokens` is pure and the presets are static, so there is nothing to
 * recompute per story — and doing it here makes switching themes a context swap
 * rather than a re-fold of a 900-key theme file on every render.
 */
const TOKENS = Object.fromEntries(BUILTIN_THEMES.map((b) => [b.id, toTokens(b.theme)] as const))

const THEME_ITEMS = BUILTIN_THEMES.map((b) => ({ value: b.id, title: b.theme.name ?? b.id }))

/**
 * Storybook preview config.
 *
 * ## The theme switcher runs the REAL provider
 *
 * Storybook's `backgrounds` addon is deliberately not used for this. It paints
 * the preview iframe and nothing else, so a component would sit on a light
 * plate while every `--sb-*` token it reads stayed dark — which looks like a bug
 * in the component rather than a limitation of the tool.
 *
 * Mounting `ThemeProvider` means Storybook exercises the same stylesheet swap
 * the app does: the same `<style id="jingler-theme">`, the same
 * `data-theme-kind` attribute. A component that hardcodes a hex fails here
 * exactly as it would in production, which is the entire point of checking it
 * here first.
 *
 * Every built-in is offered, not just the two Jingler themes. The imported ones
 * are where theming actually breaks — Monokai puts its selection colour in
 * `panel.background`, Light Modern gives `foreground` and `descriptionForeground`
 * the same value — so they are the useful cases to flip through.
 */
const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Colour theme",
      toolbar: { title: "Theme", icon: "paintbrush", items: THEME_ITEMS, dynamicTitle: true }
    }
  },
  initialGlobals: { theme: "jingler-dark" },

  decorators: [
    (Story, context) => {
      const id = (context.globals["theme"] as string | undefined) ?? "jingler-dark"
      const tokens = TOKENS[id] ?? TOKENS["jingler-dark"]!
      return createElement(
        ThemeProvider,
        { tokens, activeId: id },
        // Mirrors the `MotionConfig` in `AppShell`, so a component's motion
        // looks the same here as in the app — including the reduced-motion
        // behaviour, which is the whole reason to approve it in Storybook.
        createElement(
          MotionConfig,
          { reducedMotion: "user" },
          // Something has to paint the ground. In the app that is `AppShell`;
          // here it is this wrapper, so a `layout: "centered"` story is not left
          // transparent over Storybook's own white chrome.
          createElement("div", { className: "bg-canvas text-text" }, createElement(Story))
        )
      )
    }
  ],

  parameters: {
    layout: "centered",
    // No `backgrounds` values. They were three hardcoded One Dark hexes, and
    // they went stale the moment the default theme moved — silently, because a
    // background that is merely the wrong grey still looks deliberate.
    backgrounds: { disable: true },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    a11y: { test: "todo" }
  }
}

export default preview

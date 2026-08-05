import type { ThemeTokens, VsCodeTheme } from "@jingler/core"
import { toShikiTheme } from "@jingler/themes"
import {
  registerCustomTheme,
  type ThemeRegistration
} from "@pierre/diffs"
import {
  themeToTreeStyles,
  type TreeThemeStyles
} from "@pierre/trees"

/**
 * Pierre renders inside shadow roots, so normal Tailwind utilities cannot
 * reach its rows. Keep the bridge on Pierre's documented custom-property
 * surface and point every colour back at Jingler's live theme tokens.
 */
export const PIERRE_DIFF_TOKEN_CSS = `
:host {
  --diffs-bg-context-override: var(--sb-editor);
  --diffs-bg-context-gutter-override: var(--sb-sunken);
  --diffs-bg-buffer-override: var(--sb-editor);
  --diffs-bg-separator-override: var(--sb-sunken);
  --diffs-bg-addition-override: var(--sb-diff-add-bg);
  --diffs-bg-addition-emphasis-override: var(--sb-diff-add-bg);
  --diffs-bg-addition-number-override: var(--sb-diff-add-bg);
  --diffs-bg-deletion-override: var(--sb-diff-del-bg);
  --diffs-bg-deletion-emphasis-override: var(--sb-diff-del-bg);
  --diffs-bg-deletion-number-override: var(--sb-diff-del-bg);
  --diffs-bg-hover-override: var(--sb-hover);
  --diffs-bg-selection-override: var(--sb-selection);
  --diffs-bg-selection-number-override: var(--sb-selection);
  --diffs-fg-number-override: var(--sb-dim);
  --diffs-fg-number-addition-override: var(--sb-diff-add-fg);
  --diffs-fg-number-deletion-override: var(--sb-diff-del-fg);
  --diffs-addition-color-override: var(--sb-green);
  --diffs-deletion-color-override: var(--sb-red);
  --diffs-modified-color-override: var(--sb-yellow);
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-font-size: calc(12px * var(--sb-font-scale, 1));
  --diffs-line-height: 1.85;
}
`

/** Public tree styling surface shared by every Jingler tree host. */
export const PIERRE_TREE_TOKEN_STYLES: TreeThemeStyles = {
  "--trees-bg-override": "var(--sb-panel)",
  "--trees-bg-muted-override": "var(--sb-surface)",
  "--trees-fg-override": "var(--sb-text)",
  "--trees-fg-muted-override": "var(--sb-muted)",
  "--trees-border-color-override": "var(--sb-line)",
  "--trees-focus-ring-color-override": "var(--sb-blue)",
  "--trees-selected-bg-override": "var(--sb-selection)",
  "--trees-selected-fg-override": "var(--sb-text-bright)",
  "--trees-selected-focused-border-color-override": "var(--sb-blue)",
  "--trees-input-bg-override": "var(--sb-sunken)",
  "--trees-search-bg-override": "var(--sb-sunken)",
  "--trees-search-fg-override": "var(--sb-text)",
  "--trees-scrollbar-thumb-override": "var(--sb-scrollbar)",
  "--trees-indent-guide-bg-override": "var(--sb-border)",
  "--trees-git-added-color-override": "var(--sb-green)",
  "--trees-git-deleted-color-override": "var(--sb-red)",
  "--trees-git-ignored-color-override": "var(--sb-dim)",
  "--trees-git-modified-color-override": "var(--sb-yellow)",
  "--trees-git-renamed-color-override": "var(--sb-blue)",
  "--trees-git-untracked-color-override": "var(--sb-cyan)",
  "--trees-font-family-override": "var(--font-sans)"
}

export interface PierreThemeAdapter {
  /** Unique registered Shiki theme name used by main-thread and worker renders. */
  readonly diffTheme: string
  readonly themeType: "dark" | "light"
  readonly treeStyles: TreeThemeStyles
  readonly unsafeDiffCSS: string
}

const registeredThemes = new Set<string>()

const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

const fallbackTheme = (tokens: ThemeTokens): VsCodeTheme => ({
  name: "Jingler active theme",
  type: tokens.kind === "light" ? "light" : "dark",
  colors: {
    "editor.background": tokens.sunken,
    "editor.foreground": tokens.textBody,
    "sideBar.background": tokens.panel,
    "sideBar.foreground": tokens.text,
    "sideBar.border": tokens.line,
    "focusBorder": tokens.blue,
    "list.activeSelectionBackground": tokens.selection,
    "list.activeSelectionForeground": tokens.textBright,
    "list.hoverBackground": tokens.hover,
    "scrollbarSlider.background": tokens.scrollbar,
    "gitDecoration.addedResourceForeground": tokens.green,
    "gitDecoration.deletedResourceForeground": tokens.red,
    "gitDecoration.modifiedResourceForeground": tokens.yellow,
    "gitDecoration.renamedResourceForeground": tokens.blue,
    "gitDecoration.untrackedResourceForeground": tokens.cyan
  },
  tokenColors: []
})

const registeredTheme = (
  source: VsCodeTheme,
  tokens: ThemeTokens,
  name: string
): ThemeRegistration => {
  const theme = toShikiTheme(source, tokens)
  const mutableScope = (
    scope: string | ReadonlyArray<string> | undefined
  ): string | string[] | undefined =>
    typeof scope === "string" || scope === undefined ? scope : Array.from(scope)
  return {
    ...theme,
    name,
    tokenColors: theme.tokenColors.map((rule) => ({
      ...rule,
      scope: mutableScope(rule.scope),
      settings: { ...rule.settings }
    }))
  }
}

/**
 * Convert the active VS Code theme to both Pierre theme surfaces.
 *
 * Theme registrations are immutable in Pierre. A content fingerprint in the
 * name means an edited user theme registers as a new revision, allowing the
 * mounted worker pool to switch without stale syntax rules.
 */
export const createPierreThemeAdapter = (
  theme: VsCodeTheme | null,
  tokens: ThemeTokens
): PierreThemeAdapter => {
  const source = theme ?? fallbackTheme(tokens)
  const themeName = `jingler-${fingerprint(JSON.stringify({ source, tokens }))}`
  const shikiTheme = registeredTheme(source, tokens, themeName)

  if (!registeredThemes.has(themeName)) {
    registerCustomTheme(themeName, async () => shikiTheme)
    registeredThemes.add(themeName)
  }

  return {
    diffTheme: themeName,
    themeType: tokens.kind === "light" ? "light" : "dark",
    treeStyles: {
      ...themeToTreeStyles(shikiTheme),
      ...PIERRE_TREE_TOKEN_STYLES
    },
    unsafeDiffCSS: PIERRE_DIFF_TOKEN_CSS
  }
}

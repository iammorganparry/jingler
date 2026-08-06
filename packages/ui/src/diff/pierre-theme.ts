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
 * Visual contract for Jingler's Pierre skin.
 *
 * The reference is the renderer at 64a539e, immediately before Pierre landed
 * in 554b8ef. This is a measurements-and-token contract, not an invitation to
 * restore the deleted renderer. Pierre continues to own rendering, selection,
 * editing, annotations, and virtualization.
 *
 * Keep Pierre DOM knowledge in this module. The selectors below are exercised
 * against rendered shadow roots so a dependency upgrade fails loudly when the
 * beta structure changes.
 */
export const JINGLER_PIERRE_VISUAL_CONTRACT = {
  reference: "64a539e (parent of Pierre migration 554b8ef)",
  metrics: {
    codeFontSizePx: 11,
    codeLineHeight: 1.85,
    lineRowHeightPx: 21,
    fileHeaderHeightPx: 34,
    hunkHeaderHeightPx: 26,
    gutterColumnWidthPx: 40,
    gutterColumnCount: 2,
    signColumnWidthPx: 16,
    selectionRuleWidthPx: 2
  },
  tokens: {
    codeBackground: "var(--sb-editor)",
    codeForeground: "var(--sb-text-body)",
    fileHeaderBackground: "var(--sb-surface)",
    hunkBackground: "var(--sb-sunken)",
    hunkForeground: "var(--sb-cyan)",
    border: "var(--sb-border)",
    gutterForeground: "var(--sb-line-strong)",
    additionBackground: "var(--sb-diff-add-bg)",
    additionForeground: "var(--sb-diff-add-fg)",
    additionSign: "var(--sb-green)",
    deletionBackground: "var(--sb-diff-del-bg)",
    deletionForeground: "var(--sb-diff-del-fg)",
    deletionSign: "var(--sb-red)",
    selectionBackground: "var(--sb-selection)",
    selectionRule: "var(--sb-blue)"
  },
  selectors: {
    fileHeader: '[data-diffs-header="default"]',
    hunkHeader:
      '[data-separator="line-info"], [data-separator="line-info-basic"], [data-separator="metadata"]',
    line: "[data-line]",
    gutter: "[data-gutter]",
    lineNumber: "[data-column-number]",
    syntaxToken: "[data-line] span",
    addition: '[data-line-type="change-addition"]',
    deletion: '[data-line-type="change-deletion"]',
    selectedLine: "[data-selected-line]"
  }
} as const

export const PIERRE_HOST_CLASS = "jingler-pierre-host"

const legacyMetrics = JINGLER_PIERRE_VISUAL_CONTRACT.metrics

/**
 * Pierre renders inside shadow roots, so normal Tailwind utilities cannot
 * reach its rows. Keep the bridge on Pierre's documented custom-property
 * surface and point every colour back at Jingler's live theme tokens.
 */
export const PIERRE_DIFF_TOKEN_CSS = `
:host {
  --diffs-bg-context-override: var(--sb-editor);
  --diffs-bg-context-gutter-override: var(--sb-editor);
  --diffs-bg-buffer-override: var(--sb-sunken);
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
  --diffs-header-font-family: var(--font-mono);
  --diffs-font-size: calc(${legacyMetrics.codeFontSizePx}px * var(--sb-font-scale, 1));
  --diffs-line-height: ${legacyMetrics.codeLineHeight};
  --diffs-gap-block: 0px;
  --diffs-gap-inline: 8px;
  --diffs-gap-style: 0 solid transparent;
}

/* One shared skin for File, FileDiff, CodeView, and Editor. */
[data-diff][data-unified] {
  --diffs-code-grid: ${legacyMetrics.gutterColumnWidthPx * legacyMetrics.gutterColumnCount}px minmax(0, 1fr);
}

[data-file] {
  --diffs-code-grid: ${legacyMetrics.gutterColumnWidthPx}px minmax(0, 1fr);
}

[data-line],
[data-column-number],
[data-gutter-buffer],
[data-content-buffer],
[data-no-newline] {
  min-height: calc(${legacyMetrics.lineRowHeightPx}px * var(--sb-font-scale, 1));
}

[data-line],
[data-column-number],
[data-no-newline] {
  padding-block: 0;
}

[data-column-number] {
  box-sizing: border-box;
  width: ${legacyMetrics.gutterColumnWidthPx}px;
  min-width: ${legacyMetrics.gutterColumnWidthPx}px;
  padding-inline: 0 8px;
  color: var(--sb-line-strong);
  align-content: center;
}

[data-unified] [data-column-number],
[data-unified] [data-gutter-buffer] {
  box-sizing: border-box;
  width: ${legacyMetrics.gutterColumnWidthPx * legacyMetrics.gutterColumnCount}px;
  min-width: ${legacyMetrics.gutterColumnWidthPx * legacyMetrics.gutterColumnCount}px;
}

[data-unified] [data-column-number] {
  display: grid;
  grid-template-columns: repeat(${legacyMetrics.gutterColumnCount}, ${legacyMetrics.gutterColumnWidthPx}px);
  padding: 0;
  text-align: right;
}

/* Pierre exposes one primary number in unified mode. Mirror context rows into
 * the old-side column, while additions/deletions retain their natural side. */
[data-unified] [data-column-number]::before,
[data-unified] [data-line-number-content] {
  box-sizing: border-box;
  width: ${legacyMetrics.gutterColumnWidthPx}px;
  min-width: ${legacyMetrics.gutterColumnWidthPx}px;
  padding-right: 8px;
  text-align: right;
}

[data-unified] [data-column-number]::before {
  content: attr(data-column-number);
  grid-column: 1;
  color: inherit;
}

[data-unified] [data-line-number-content] {
  grid-column: 2;
}

[data-unified] [data-column-number][data-line-type="change-addition"]::before,
[data-unified] [data-column-number][data-line-type="change-deletion"] [data-line-number-content] {
  content: "";
  visibility: hidden;
}

[data-unified] [data-column-number][data-line-type="change-deletion"]::before {
  content: attr(data-column-number);
  visibility: visible;
}

[data-unified][data-disable-line-numbers] {
  --diffs-code-grid: 4px minmax(0, 1fr);
}

[data-unified][data-disable-line-numbers] [data-column-number],
[data-unified][data-disable-line-numbers] [data-gutter-buffer] {
  display: block;
  width: 4px;
  min-width: 4px;
  padding: 0;
}

[data-unified][data-disable-line-numbers] [data-column-number]::before {
  content: none;
}

[data-indicators="classic"] [data-line] {
  padding-inline: ${legacyMetrics.signColumnWidthPx}px 8px;
}

[data-indicators="classic"] [data-line-type="change-addition"][data-line]::before,
[data-indicators="classic"] [data-line-type="change-deletion"][data-line]::before {
  width: ${legacyMetrics.signColumnWidthPx}px;
  text-align: center;
}

[data-line-type="change-addition"][data-line]::before {
  color: var(--sb-green);
}

[data-line-type="change-deletion"][data-line]::before {
  color: var(--sb-red);
}

:where([data-line], [data-column-number])[data-line-type="change-addition"] {
  --diffs-computed-diff-line-bg: var(--sb-diff-add-bg);
}

:where([data-line], [data-column-number])[data-line-type="change-deletion"] {
  --diffs-computed-diff-line-bg: var(--sb-diff-del-bg);
}

[data-column-number][data-line-type="change-addition"] {
  color: var(--sb-diff-add-fg);
}

[data-column-number][data-line-type="change-deletion"] {
  color: var(--sb-diff-del-fg);
}

[data-line] {
  color: var(--sb-text-body);
}

/* Preserve Shiki token foregrounds: changes and selection only paint washes. */
[data-line] span {
  color: light-dark(
    var(--diffs-token-light, var(--diffs-light)),
    var(--diffs-token-dark, var(--diffs-dark))
  );
}

[data-diffs-header="default"] {
  box-sizing: border-box;
  height: ${legacyMetrics.fileHeaderHeightPx}px;
  min-height: ${legacyMetrics.fileHeaderHeightPx}px;
  padding-inline: 12px;
  border-block: 1px solid var(--sb-border);
  background: var(--sb-surface);
  color: var(--sb-muted);
  font-size: calc(${legacyMetrics.codeFontSizePx}px * var(--sb-font-scale, 1));
  font-weight: 400;
}

[data-diffs-header="default"] [data-title] {
  color: var(--sb-text-bright);
}

[data-diffs-header="custom"] {
  box-sizing: border-box;
  min-height: ${legacyMetrics.fileHeaderHeightPx}px;
  border-block: 1px solid var(--sb-border);
  background: var(--sb-surface);
}

[data-separator="line-info"],
[data-separator="line-info-basic"],
[data-separator="metadata"] {
  box-sizing: border-box;
  height: ${legacyMetrics.hunkHeaderHeightPx}px;
  min-height: ${legacyMetrics.hunkHeaderHeightPx}px;
  margin-block: 0;
  border-block: 1px solid var(--sb-border);
  background: var(--sb-sunken);
  color: var(--sb-cyan);
  font-size: calc(10.5px * var(--sb-font-scale, 1));
}

[data-separator-wrapper],
[data-expand-button],
[data-separator-content] {
  background: var(--sb-sunken);
}

[data-separator-content],
[data-unmodified-lines] {
  color: var(--sb-cyan);
}

[data-selected-line] {
  --diffs-computed-selected-line-bg: var(--sb-selection);
}

[data-column-number][data-selected-line] {
  color: var(--sb-blue);
}

[data-column-number][data-selected-line]::after {
  content: "";
  position: absolute;
  inset-block: 0;
  left: 0;
  width: ${legacyMetrics.selectionRuleWidthPx}px;
  background: var(--sb-blue);
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

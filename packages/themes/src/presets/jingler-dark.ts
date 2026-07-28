/**
 * Jingler Dark — Jingler's own brand theme. HAND-AUTHORED.
 *
 * NOT produced by `scripts/vendor-themes.mjs`. Every OTHER file in this
 * directory is machine-generated from a VS Code built-in and carries a "do not
 * edit by hand" banner; this one is the exact opposite. The vendor script's
 * `PRESETS` table does not list `jingler-dark`, so `pnpm --filter
 * @jingler/themes vendor` must never write or overwrite this file — if a future
 * edit to the script starts emitting it, that is the bug, not this comment.
 *
 * ## Why the surfaces are what they are
 *
 * Brand red is `#EF3F57` and the wordmark's own neutral is `#212121`. The
 * temptation with a red brand is to tint the chrome red; we do not. A red-washed
 * editor is fatiguing to read against for the length of a real coding session,
 * so the surfaces are warm-neutral greys — `#212121` for the editor (the
 * wordmark colour itself), stepping DOWN toward black for the recessed planes
 * the way `SURFACE_STEPS.dark` expects: sidebar `#1b1b1b`, panels/terminal
 * `#181818`, title bar / tab strip `#141414`. Red appears only where the eye
 * wants a single point of emphasis: the cursor, the primary button, focus
 * rings, links, the progress and badge chips. The mapper reads
 * `editor.background` → `sideBar.background` → `panel.background` →
 * `titleBar.activeBackground` for its four surface planes, so those keys are set
 * to land the fold on `#212121 / #1b1b1b / #181818 / #141414` exactly.
 *
 * ## Why the syntax ramp stays full-spectrum
 *
 * Same reasoning inverted: collapsing the token colours toward red because the
 * brand is red would make code unreadable. `tokenColors` keeps seven visually
 * distinct hues drawn from the terminal ANSI ramp below — purple keywords,
 * green strings, blue functions, yellow types, orange numbers/constants, red
 * tags/variables, cyan operators — with dim italic comments. The diff viewer
 * highlights with shiki off these same rules, so a thin `tokenColors` would make
 * code render as flat grey; it is deliberately complete.
 *
 * The mapper (`../map.ts`) folds a handful of these keys down to `ThemeTokens`;
 * the rest are here so the theme is also a faithful, readable theme in a real
 * VS Code editor.
 */
import type { VsCodeTheme } from "@jingler/core"

export const jinglerDark: VsCodeTheme = {
  "name": "Jingler Dark",
  "type": "dark",
  "colors": {
    // ── Surfaces (drive the fold: editor → panel → sunken → canvas) ──────────
    "editor.background": "#212121",
    "editor.foreground": "#c6c1c1",
    "foreground": "#dedada",
    "sideBar.background": "#1b1b1b",
    "sideBar.foreground": "#c6c1c1",
    "activityBar.background": "#1b1b1b",
    "activityBar.foreground": "#dedada",
    "panel.background": "#181818",
    "terminal.background": "#181818",
    "dropdown.background": "#181818",
    "dropdown.foreground": "#c6c1c1",
    "titleBar.activeBackground": "#141414",
    "titleBar.activeForeground": "#dedada",
    "titleBar.inactiveBackground": "#141414",
    "titleBar.inactiveForeground": "#8d8686",
    "editorGroupHeader.tabsBackground": "#141414",
    "list.hoverBackground": "#2b2b2b",
    "input.background": "#1b1b1b",
    "input.foreground": "#dedada",
    "editorWidget.background": "#181818",
    "quickInput.background": "#181818",
    "sideBarSectionHeader.background": "#1b1b1b",
    "statusBar.background": "#141414",
    "statusBar.foreground": "#8d8686",
    "tab.activeBackground": "#212121",
    "tab.inactiveBackground": "#141414",

    // ── Borders ──────────────────────────────────────────────────────────────
    "editorGroup.border": "#0f0f0f",
    "sideBar.border": "#0f0f0f",
    "panel.border": "#333333",
    "input.border": "#333333",
    "contrastBorder": "#454545",

    // ── Text ramp (brightest → dimmest) ──────────────────────────────────────
    "tab.activeForeground": "#f4f1f1",
    "list.activeSelectionForeground": "#f4f1f1",
    "descriptionForeground": "#8d8686",
    "tab.inactiveForeground": "#8d8686",
    "editorLineNumber.foreground": "#6a6363",
    "editorLineNumber.activeForeground": "#c6c1c1",

    // ── Accents — brand red where the eye wants one point of emphasis ────────
    "progressBar.background": "#EF3F57",
    "activityBarBadge.background": "#EF3F57",
    "activityBarBadge.foreground": "#ffffff",
    "button.background": "#EF3F57",
    "button.foreground": "#ffffff",
    "button.hoverBackground": "#f5687b",
    "focusBorder": "#EF3F57",
    "textLink.foreground": "#EF3F57",
    "textLink.activeForeground": "#f5687b",
    "terminalCursor.foreground": "#EF3F57",
    "editorCursor.foreground": "#EF3F57",
    "list.activeSelectionBackground": "#2b2b2b",

    // ── Terminal ANSI — the full-spectrum ramp the syntax rules borrow from ──
    "terminal.foreground": "#c6c1c1",
    "terminal.ansiBlack": "#333333",
    "terminal.ansiRed": "#ee8372",
    "terminal.ansiGreen": "#70d294",
    "terminal.ansiYellow": "#ebcb60",
    "terminal.ansiBlue": "#6faef6",
    "terminal.ansiMagenta": "#db91ed",
    "terminal.ansiCyan": "#5eccd4",
    "terminal.ansiWhite": "#c6c1c1",
    "terminal.ansiBrightBlack": "#6a6363",
    "terminal.ansiBrightRed": "#f3aba0",
    "terminal.ansiBrightGreen": "#96deb1",
    "terminal.ansiBrightYellow": "#f1a35f",
    "terminal.ansiBrightBlue": "#9fc9f9",
    "terminal.ansiBrightMagenta": "#e9bdf4",
    "terminal.ansiBrightCyan": "#86d9df",
    "terminal.ansiBrightWhite": "#f4f1f1",

    // ── Diff & git — a wash, so syntax stays legible on top ──────────────────
    "editor.selectionBackground": "#EF3F5738",
    "diffEditor.insertedTextBackground": "#70d29420",
    "diffEditor.removedTextBackground": "#ee837220",
    "gitDecoration.addedResourceForeground": "#447e59",
    "gitDecoration.deletedResourceForeground": "#855047",
    "editorGutter.addedBackground": "#447e59",
    "editorGutter.deletedBackground": "#855047",

    // ── Scrollbars ───────────────────────────────────────────────────────────
    "scrollbarSlider.background": "#ffffff20",
    "scrollbarSlider.hoverBackground": "#ffffff33"
  },
  "tokenColors": [
    {
      "scope": ["comment", "punctuation.definition.comment"],
      "settings": {
        "fontStyle": "italic",
        "foreground": "#6a6363"
      }
    },
    {
      "scope": ["string", "string.quoted", "string.template"],
      "settings": {
        "foreground": "#70d294"
      }
    },
    {
      "scope": ["constant.numeric", "constant.numeric.integer", "constant.numeric.float"],
      "settings": {
        "foreground": "#f1a35f"
      }
    },
    {
      "scope": ["constant.language", "constant.language.boolean", "constant.language.null"],
      "settings": {
        "foreground": "#f1a35f"
      }
    },
    {
      "scope": ["constant.character.escape", "constant.other.symbol"],
      "settings": {
        "foreground": "#5eccd4"
      }
    },
    {
      "scope": ["variable", "variable.other.readwrite", "meta.definition.variable.name", "support.variable"],
      "settings": {
        "foreground": "#ee8372"
      }
    },
    {
      "scope": ["variable.parameter", "variable.parameter.function"],
      "settings": {
        "fontStyle": "italic",
        "foreground": "#c6c1c1"
      }
    },
    {
      "scope": ["entity.name.function", "support.function", "meta.function-call", "variable.function"],
      "settings": {
        "foreground": "#6faef6"
      }
    },
    {
      "scope": [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
        "entity.name.namespace"
      ],
      "settings": {
        "foreground": "#ebcb60"
      }
    },
    {
      "scope": ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
      "settings": {
        "foreground": "#db91ed"
      }
    },
    {
      "scope": ["keyword.operator", "keyword.operator.logical", "keyword.operator.arithmetic"],
      "settings": {
        "foreground": "#5eccd4"
      }
    },
    {
      "scope": ["entity.name.tag", "punctuation.definition.tag"],
      "settings": {
        "foreground": "#ee8372"
      }
    },
    {
      "scope": ["entity.other.attribute-name"],
      "settings": {
        "foreground": "#f1a35f"
      }
    },
    {
      "scope": [
        "punctuation",
        "punctuation.separator",
        "punctuation.terminator",
        "punctuation.definition.parameters",
        "meta.brace.round",
        "meta.brace.square"
      ],
      "settings": {
        "foreground": "#8d8686"
      }
    },
    {
      "scope": ["meta.object-literal.key", "support.type.property-name"],
      "settings": {
        "foreground": "#ee8372"
      }
    },
    {
      "scope": ["support.type.property-name.json", "support.type.property-name.toml"],
      "settings": {
        "foreground": "#ee8372"
      }
    },
    {
      "scope": ["string.regexp", "constant.other.character-class.regexp"],
      "settings": {
        "foreground": "#5eccd4"
      }
    },
    {
      "scope": ["markup.heading", "markup.heading entity.name", "entity.name.section.markdown"],
      "settings": {
        "fontStyle": "bold",
        "foreground": "#ee8372"
      }
    },
    {
      "scope": ["markup.bold", "punctuation.definition.bold"],
      "settings": {
        "fontStyle": "bold",
        "foreground": "#f1a35f"
      }
    },
    {
      "scope": ["markup.italic", "punctuation.definition.italic"],
      "settings": {
        "fontStyle": "italic",
        "foreground": "#db91ed"
      }
    },
    {
      "scope": ["markup.inline.raw", "markup.raw", "markup.inline.raw.string.markdown"],
      "settings": {
        "foreground": "#70d294"
      }
    },
    {
      "scope": ["markup.inserted", "markup.inserted.diff"],
      "settings": {
        "foreground": "#70d294"
      }
    },
    {
      "scope": ["markup.deleted", "markup.deleted.diff"],
      "settings": {
        "foreground": "#ee8372"
      }
    },
    {
      "scope": ["markup.underline.link", "string.other.link.title.markdown"],
      "settings": {
        "foreground": "#6faef6"
      }
    },
    {
      "scope": ["invalid", "invalid.illegal", "invalid.broken"],
      "settings": {
        "foreground": "#ee8372"
      }
    }
  ],
  "semanticHighlighting": true
}

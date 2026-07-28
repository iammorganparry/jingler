/**
 * Jingler Light — Jingler's own brand theme. HAND-AUTHORED.
 *
 * NOT produced by `scripts/vendor-themes.mjs`. Every OTHER file in this
 * directory is machine-generated from a VS Code built-in and carries a "do not
 * edit by hand" banner; this one is the exact opposite. The vendor script's
 * `PRESETS` table does not list `jingler-light`, so `pnpm --filter
 * @jingler/themes vendor` must never write or overwrite this file — if a future
 * edit to the script starts emitting it, that is the bug, not this comment.
 *
 * ## Why the surfaces are what they are
 *
 * The light twin of Jingler Dark. Brand red darkens to `#d92e46` here because
 * `#EF3F57` on white does not clear the text/accent contrast a light ground
 * needs — a light theme's accents have to go DARKER, there is no white to lift
 * toward. Surfaces are warm-neutral (a faint red-grey warmth from the brand, not
 * a red tint) stepping DOWN from a pure-white editor the way `SURFACE_STEPS.light`
 * expects, in much smaller steps than dark uses: editor `#ffffff`, sidebar
 * `#f9f6f6`, panels/terminal `#f4f0f0`, title bar / tab strip `#efeaea`. The
 * mapper reads `editor.background` → `sideBar.background` → `panel.background` →
 * `titleBar.activeBackground`, so those keys land the fold on
 * `#ffffff / #f9f6f6 / #f4f0f0 / #efeaea` exactly.
 *
 * ## Why the syntax ramp stays full-spectrum
 *
 * Seven distinct hues, the light equivalents of the dark ramp, borrowed from the
 * terminal ANSI ramp below — blue functions, green strings, yellow/brown types,
 * red tags/variables, purple keywords, teal operators, orange numbers/constants
 * — with dim italic comments. Collapsing toward red would make code unreadable,
 * and a thin `tokenColors` would make the shiki-backed diff viewer render code as
 * flat grey, so this array is deliberately complete.
 */
import type { VsCodeTheme } from "@jingler/core"

export const jinglerLight: VsCodeTheme = {
  "name": "Jingler Light",
  "type": "light",
  "colors": {
    // ── Surfaces (drive the fold: editor → panel → sunken → canvas) ──────────
    "editor.background": "#ffffff",
    "editor.foreground": "#403939",
    "foreground": "#2c2727",
    "sideBar.background": "#f9f6f6",
    "sideBar.foreground": "#403939",
    "activityBar.background": "#f9f6f6",
    "activityBar.foreground": "#2c2727",
    "panel.background": "#f4f0f0",
    "terminal.background": "#f4f0f0",
    "dropdown.background": "#f4f0f0",
    "dropdown.foreground": "#403939",
    "titleBar.activeBackground": "#efeaea",
    "titleBar.activeForeground": "#2c2727",
    "titleBar.inactiveBackground": "#efeaea",
    "titleBar.inactiveForeground": "#6b6262",
    "editorGroupHeader.tabsBackground": "#efeaea",
    "list.hoverBackground": "#f1ecec",
    "input.background": "#ffffff",
    "input.foreground": "#2c2727",
    "editorWidget.background": "#f4f0f0",
    "quickInput.background": "#f4f0f0",
    "sideBarSectionHeader.background": "#f9f6f6",
    "statusBar.background": "#efeaea",
    "statusBar.foreground": "#6b6262",
    "tab.activeBackground": "#ffffff",
    "tab.inactiveBackground": "#efeaea",

    // ── Borders ──────────────────────────────────────────────────────────────
    "editorGroup.border": "#e3dcdc",
    "sideBar.border": "#e3dcdc",
    "panel.border": "#ded6d6",
    "input.border": "#ded6d6",
    "contrastBorder": "#c8bfbf",

    // ── Text ramp (brightest → dimmest) ──────────────────────────────────────
    "tab.activeForeground": "#191616",
    "list.activeSelectionForeground": "#191616",
    "descriptionForeground": "#6b6262",
    "tab.inactiveForeground": "#6b6262",
    "editorLineNumber.foreground": "#8d8383",
    "editorLineNumber.activeForeground": "#403939",

    // ── Accents — brand red darkened for a light ground ──────────────────────
    "progressBar.background": "#d92e46",
    "activityBarBadge.background": "#d92e46",
    "activityBarBadge.foreground": "#ffffff",
    "button.background": "#d92e46",
    "button.foreground": "#ffffff",
    "button.hoverBackground": "#b80f26",
    "focusBorder": "#d92e46",
    "textLink.foreground": "#d92e46",
    "textLink.activeForeground": "#b80f26",
    "terminalCursor.foreground": "#d92e46",
    "editorCursor.foreground": "#d92e46",
    "list.activeSelectionBackground": "#f1ecec",

    // ── Terminal ANSI — the full-spectrum ramp the syntax rules borrow from ──
    "terminal.foreground": "#403939",
    "terminal.ansiBlack": "#24292f",
    "terminal.ansiRed": "#bd341f",
    "terminal.ansiGreen": "#1b793d",
    "terminal.ansiYellow": "#937206",
    "terminal.ansiBlue": "#145eb3",
    "terminal.ansiMagenta": "#9737ae",
    "terminal.ansiCyan": "#15787f",
    "terminal.ansiWhite": "#403939",
    "terminal.ansiBrightBlack": "#8d8383",
    "terminal.ansiBrightRed": "#a40e26",
    "terminal.ansiBrightGreen": "#1b793d",
    "terminal.ansiBrightYellow": "#a8540b",
    "terminal.ansiBrightBlue": "#0969da",
    "terminal.ansiBrightMagenta": "#9737ae",
    "terminal.ansiBrightCyan": "#15787f",
    "terminal.ansiBrightWhite": "#191616",

    // ── Diff & git — a wash, so syntax stays legible on top ──────────────────
    "editor.selectionBackground": "#d92e4626",
    "diffEditor.insertedTextBackground": "#1b793d22",
    "diffEditor.removedTextBackground": "#bd341f1f",
    "gitDecoration.addedResourceForeground": "#1b793d",
    "gitDecoration.deletedResourceForeground": "#bd341f",
    "editorGutter.addedBackground": "#1b793d",
    "editorGutter.deletedBackground": "#bd341f",

    // ── Scrollbars ───────────────────────────────────────────────────────────
    "scrollbarSlider.background": "#24292f28",
    "scrollbarSlider.hoverBackground": "#24292f44"
  },
  "tokenColors": [
    {
      "scope": ["comment", "punctuation.definition.comment"],
      "settings": {
        "fontStyle": "italic",
        "foreground": "#8d8383"
      }
    },
    {
      "scope": ["string", "string.quoted", "string.template"],
      "settings": {
        "foreground": "#1b793d"
      }
    },
    {
      "scope": ["constant.numeric", "constant.numeric.integer", "constant.numeric.float"],
      "settings": {
        "foreground": "#a8540b"
      }
    },
    {
      "scope": ["constant.language", "constant.language.boolean", "constant.language.null"],
      "settings": {
        "foreground": "#a8540b"
      }
    },
    {
      "scope": ["constant.character.escape", "constant.other.symbol"],
      "settings": {
        "foreground": "#15787f"
      }
    },
    {
      "scope": ["variable", "variable.other.readwrite", "meta.definition.variable.name", "support.variable"],
      "settings": {
        "foreground": "#bd341f"
      }
    },
    {
      "scope": ["variable.parameter", "variable.parameter.function"],
      "settings": {
        "fontStyle": "italic",
        "foreground": "#403939"
      }
    },
    {
      "scope": ["entity.name.function", "support.function", "meta.function-call", "variable.function"],
      "settings": {
        "foreground": "#145eb3"
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
        "foreground": "#937206"
      }
    },
    {
      "scope": ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
      "settings": {
        "foreground": "#9737ae"
      }
    },
    {
      "scope": ["keyword.operator", "keyword.operator.logical", "keyword.operator.arithmetic"],
      "settings": {
        "foreground": "#15787f"
      }
    },
    {
      "scope": ["entity.name.tag", "punctuation.definition.tag"],
      "settings": {
        "foreground": "#bd341f"
      }
    },
    {
      "scope": ["entity.other.attribute-name"],
      "settings": {
        "foreground": "#a8540b"
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
        "foreground": "#6b6262"
      }
    },
    {
      "scope": ["meta.object-literal.key", "support.type.property-name"],
      "settings": {
        "foreground": "#bd341f"
      }
    },
    {
      "scope": ["support.type.property-name.json", "support.type.property-name.toml"],
      "settings": {
        "foreground": "#bd341f"
      }
    },
    {
      "scope": ["string.regexp", "constant.other.character-class.regexp"],
      "settings": {
        "foreground": "#15787f"
      }
    },
    {
      "scope": ["markup.heading", "markup.heading entity.name", "entity.name.section.markdown"],
      "settings": {
        "fontStyle": "bold",
        "foreground": "#bd341f"
      }
    },
    {
      "scope": ["markup.bold", "punctuation.definition.bold"],
      "settings": {
        "fontStyle": "bold",
        "foreground": "#a8540b"
      }
    },
    {
      "scope": ["markup.italic", "punctuation.definition.italic"],
      "settings": {
        "fontStyle": "italic",
        "foreground": "#9737ae"
      }
    },
    {
      "scope": ["markup.inline.raw", "markup.raw", "markup.inline.raw.string.markdown"],
      "settings": {
        "foreground": "#1b793d"
      }
    },
    {
      "scope": ["markup.inserted", "markup.inserted.diff"],
      "settings": {
        "foreground": "#1b793d"
      }
    },
    {
      "scope": ["markup.deleted", "markup.deleted.diff"],
      "settings": {
        "foreground": "#bd341f"
      }
    },
    {
      "scope": ["markup.underline.link", "string.other.link.title.markdown"],
      "settings": {
        "foreground": "#145eb3"
      }
    },
    {
      "scope": ["invalid", "invalid.illegal", "invalid.broken"],
      "settings": {
        "foreground": "#bd341f"
      }
    }
  ],
  "semanticHighlighting": true
}

# Jingler design system — "Conductor-calm" (Jingler Graphite)

Near-black, low-chroma neutrals, one accent. Colour is used only for state. Source of truth: `packages/ui/src/globals.css` (`--sb-*` tokens, re-exported to Tailwind as `bg-panel`, `border-line`, `text-text-bright`, ...). Never hardcode hex in components.

## Tokens
- Surfaces: canvas #0b0b0c, sunken #0e0e0f, panel #131315, editor/elevated #1a1a1d, surface/hover #202024
- Lines: border #232327 (hairline), line #303036 (inputs), line-strong #44444c
- Text: bright #ededef, body #dcdce0, text #c4c4cb, muted #a1a1aa (text-2), dim #7c7c86 (text-3)
- Brand rose #ef3f57: focus ring, selection, mark ONLY. Primary CTA fill = #ededef on #0b0b0c.
- State: working #6faef6, needs #ebcb60, ready #70d294, failed #f0605d
- Fonts: Hanken Grotesk (UI), JetBrains Mono (code). Weights 400/500/600.
- Type scale: 11 / 12 / 13 (default) / 15 / 20
- Radii: 6 (chips, buttons, rows) / 8 (inputs, menus) / 12 (cards, dialogs)
- Spacing: 4px grid. Control heights 28 (sm) / 32 (default). Row 32.
- Shadows only on floating layers.

## Form controls (target)
- Switch: 28x16 track, 12px thumb (sm 24x14 / 10px). Off = line-strong, on = primary-fill. Calm, no squish.
- Input: h32, r8, 1px `line` border, transparent bg, 13px text, focus = brand ring.
- Field: label 13/500 text-bright, help 12 muted, error 12 state-failed with role=alert, required marker `*`.
- Settings card: r12, 1px border, hairline dividers; row px16 py12; label 13/500, help 12 muted; control right.

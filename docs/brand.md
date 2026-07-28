# Jingler brand

The rules, and the reasons. If you only read one section, read
[Never hardcode a colour](#never-hardcode-a-colour).

## The mark

`#EF3F57` — a hand-drawn scribble, tighter at the top than the bottom.

| File | What it is | Use it for |
| --- | --- | --- |
| `packages/ui/src/brand/jingler-mark.tsx` | The path, inline, `fill="currentColor"` | **Everything inside the app** |
| `packages/ui/src/brand/assets/jingler-mark.svg` | Standalone, brand red | READMEs, press, anything outside the bundler |
| `packages/ui/src/brand/assets/jingler-mark-mono.svg` | Standalone, `currentColor` | One-colour print, embroidery, stickers |
| `packages/ui/src/brand/assets/jingler-logo.svg` | Mark + wordmark lockup | Marketing, docs headers |
| `packages/ui/src/brand/assets/jingler-mark-shader.png` | Mark filled **solid black** | Only `BrandShader`. See below. |

**Use `<JinglerMark />` in React, never an `<img>`.** The mark sits on the auth
card, the splash, the first-run screen and the empty state — four surfaces
across eleven themes plus anything an operator imports. A raster is one fixed
colour on all of them; `currentColor` inherits, so `text-brand` on a Jingler
theme and `text-blue` on an imported Solarized both do the right thing without
a second asset.

**The shader PNG is black on purpose.** It looks broken sitting in the assets
directory. The Paper Design `Heatmap` treats the image as a heightfield rather
than as artwork — luminance drives the contour and `colors` recolours the
result from scratch — so feeding it the brand-red mark double-applies the hue
and washes the whole thing out.

**The mark is taller than it is wide** (`viewBox="0 0 117 127"`). Set one
dimension and let the other follow; `size-5` on it gives a square box and
letterboxes the mark, which is usually what you want in a row.

### Wordmark

"Jingler", set in Hanken Grotesk Semibold, `-0.01em` tracking. It is **text, not
a traced path**, so it re-renders with the rest of the UI when the type scale
changes. `<JinglerWordmark />` is the mark + word lockup.

Clear space around the lockup: the height of the mark, on all four sides.

## The palette

Two themes ship as Jingler's own — `jingler-dark` (the default) and
`jingler-light`. Both are real VS Code theme files
(`packages/themes/src/presets/jingler-{dark,light}.ts`) and are hand-authored,
**not** produced by `scripts/vendor-themes.mjs`. Do not let the vendor script
overwrite them.

### Surfaces are warm-neutral, never red

| | dark | light |
| --- | --- | --- |
| `canvas` | `#141414` | `#efeaea` |
| `sunken` | `#171717` | `#f4f0f0` |
| `panel` | `#1b1b1b` | `#f9f6f6` |
| `editor` | `#212121` | `#ffffff` |
| `surface` | `#2b2b2b` | `#f1ecec` |

`#212121` is the wordmark's own neutral, so the greys step off it rather than
off an arbitrary slate. They are **not** hue-shifted toward the brand: a
red-washed editor looks committed for about ten minutes and unreadable for the
rest of the day, and the mark is loud enough that it does not need the walls
helping.

Half of the folded values are not stated by the preset at all — `sunken` comes
out of `enforceSurfaceRamp`, and every accent passes a contrast bar. That is why
`globals.css`'s `:root` block is **generated from `toTokens(jinglerDark)`, not
hand-typed**, and why a test pins every one of them.

### Brand red is not destructive red

```
--sb-brand        #ef3f57   primary buttons, focus rings, links, active tabs
--sb-brand-hover  #f5687b
--sb-red          #ee8372   destructive, and the syntax/ANSI red
```

**Anything sitting ON a filled brand surface is a shade of that surface**, not a
second accent — see `Kbd`'s `onFill` variant, which is `bg-white/22` rather than
a coloured chip. A keycap in another accent competes with the button it is
inside, and breaks again the next time `--primary` moves.

These are separate tokens even though Jingler's brand *is* a red. `--sb-red` is
wired to `--destructive`; collapsing them would make "Delete session" and "New
session" the same swatch, at which point the destructive tone has stopped
carrying information.

They also differ in **weight**, not just hue — primary is a filled button,
danger an outlined one — so the distinction survives for anyone who cannot tell
two reds apart. That is the part that actually matters; the hue gap is a bonus.

On an imported theme, `brand` is derived from *that* theme's accent (see the
`brand` chain in `packages/themes/src/map.ts`). A Solarized user gets a
Solarized focus ring, not ours leaking through.

### The syntax ramp stays full-spectrum — inside one envelope

Seven hues, deliberately: `blue green yellow red purple cyan orange`. The brand
is one colour; syntax highlighting needs a spectrum. Collapsing the ramp toward
red to look "on brand" makes every diff a wall of near-identical pinks, which is
a worse outcome than a slightly less unified palette. **Brand red lives in the
chrome, not in the code.**

What makes them *feel* like Jingler's is not the hue, it is the **envelope**.
Every accent sits at `S 52–88% / L 60–75%` on dark, against the brand's
`S 85% / L 59%` — so they read as one family rather than seven colours picked
separately. The hues lean warm for the same reason: purple is `288°` (magenta
side) rather than a violet `275°`, and cyan is `184°` rather than a flat `180°`.

| | dark | light | hue |
| --- | --- | --- | --- |
| `brand` | `#ef3f57` | `#d92e46` | 352° |
| `red` | `#ee8372` | `#bd341f` | 8° |
| `orange` | `#f1a35f` | `#a8540b` | 28° |
| `yellow` | `#ebcb60` | `#937206` | 46° |
| `green` | `#70d294` | `#1b793d` | 142° |
| `cyan` | `#5eccd4` | `#15787f` | 184° |
| `blue` | `#6faef6` | `#145eb3` | 212° |
| `purple` | `#db91ed` | `#9737ae` | 288° |

`red` is 16° off the brand and ten lightness points above it — close enough to
belong to the same palette, far enough that a destructive button never reads as
the primary one. A test in `packages/themes/src/map.test.ts` pins the envelope,
because a single accent reverted to a stock VS Code hex would still be a valid
colour with fine contrast and would only show up as the palette quietly looking
unrelated to itself.

Every accent clears **4.5:1** against its own theme's `editor`.

## Type

| | Family | Notes |
| --- | --- | --- |
| Sans | **Hanken Grotesk Variable** | UI, headings, body |
| Mono | **JetBrains Mono Variable** | Code, diffs, terminal, metrics |

Both are **self-hosted**, via `@fontsource-variable/*` imported at the top of
`globals.css`. Never link `fonts.gstatic.com` from the app: the renderer's CSP
(`default-src 'self'`) forbids the request, it would fail silently, and the app
would fall through to `system-ui` — which is exactly the bug this shipped with
before anyone noticed.

**The `Variable` suffix is load-bearing.** Fontsource registers its variable
faces under `"<Family> Variable"`. A stack that starts at the bare family name
misses the bundled font entirely and renders perfectly readably in the wrong
typeface, which is why nobody caught it. Anything that takes a raw font string
rather than reading `--font-sans` / `--font-mono` — xterm is the one that does
— must lead with the `Variable` name too.

## Never hardcode a colour

Every colour is a `--sb-*` custom property re-exported to Tailwind
(`bg-panel`, `text-brand`, `border-line`). A literal hex is invisible to the
theme system: it survives a theme switch unchanged, which on a light theme means
white text on white.

If the colour you need has no token, **add one — three edits, in this order**:

1. `ThemeTokens` **and** `CSS_VAR_BY_TOKEN` in `packages/core/src/theme.ts`
2. the `:root` fallback **and** the `@theme inline` mapping in
   `packages/ui/src/globals.css`
3. the fallback chain in `packages/themes/src/map.ts`

Miss (3) and the token is `undefined` for every theme but the default. Miss (2)
and no Tailwind utility exists. Only a missed (1) fails loudly.

## The loading screen

`BrandShader` (`packages/ui/src/brand/brand-shader.tsx`) runs the mark through
Paper Design's `Heatmap`. Two prop sets, dark and light, chosen off the active
theme's ground.

They are **not** one set with a different backdrop. `colorBack` is one end of
the ramp the shader interpolates through, so noise, glow and contour all read
differently against it. The light variant is *much* fainter by design — and
raising `contour` past ~0.6 to "fix" that makes it render blank, because the
mark's signal folds into the near-white ground. Raise `innerGlow` instead.

Two paths render the static mark instead of the shader: `prefers-reduced-motion`,
and a renderer with no usable WebGL context. The second is not hypothetical —
Electron falls back to SwiftShader or fails outright on some Linux and VM GPU
stacks, and a blank splash reads as "the app is broken".

**The splash runs the shader FULL-BLEED** (`<BrandShader fill />`), not as a
centred tile. Matching `colorBack` to the page is not enough on its own: the
shader lays grain across its whole rectangle, which lifts it a few levels above
a flat fill and leaves a visible square. Owning the surface removes the edge
instead of disguising it. The page colour still matters, for the one frame
before WebGL has drawn anything.

### The sign-in wall has no backdrop

It briefly had a starfield, then briefly had the shader. It now has a flat
`bg-canvas`, and the only decoration is the card's own brand halo. A starfield
said nothing about Jingler; a second animated mark competed with the form and
meant the operator watched the same animation twice before reaching the app.

## App icons

`apps/desktop/build-resources/icon.{png,ico,icns}`, generated by
`scripts/generate-brand-icons.py` (`pip install pillow`). Regenerate rather than
hand-editing — the macOS squircle grid has four numbers in it and getting one
wrong produces an icon that still looks like an icon.

The `.icns` art sits in an 824px tile inside a 1024px canvas because macOS draws
its own shadow into that margin; full-bleed art gets that shadow clipped and
reads as a sticker. Windows and Linux want no margin, so they get their own
render.

**Source-asset trap:** `jingler_social_icon.png` from the brand package looks
padded and transparent but carries an **opaque white plate** — compositing it
over a coloured ground just paints the ground white. Use `jingler-icon-color.png`.

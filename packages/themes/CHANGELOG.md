# @jingler/themes

## 2.0.3

### Patch Changes

- @jingler/core@2.0.3

## 2.0.2

### Patch Changes

- @jingler/core@2.0.2

## 2.0.1

### Patch Changes

- @jingler/core@2.0.1

## 2.0.0

### Minor Changes

- 142c0fe: Rebrand: the app now ships Jingler's own identity end to end.

  - **App icons.** `build-resources/icon.{png,ico,icns}`, generated from the mark by
    `scripts/generate-brand-icons.py`. Every installer previously shipped Electron's
    default icon.
  - **Two brand themes.** `jingler-dark` (now `DEFAULT_THEME_ID`) and `jingler-light`,
    hand-authored VS Code themes on warm-neutral greys off `#212121` with `#EF3F57`
    as the brand accent. Operators with a saved `theme.activeId` keep it.
  - **A `--sb-brand` token,** separate from `--sb-red`, so the primary action and the
    destructive action are not the same swatch. `--primary`, `--ring` and links now
    resolve through it.
  - **A retuned accent ramp.** All seven accents were rebuilt inside the brand's
    saturation/lightness envelope (S 52-88% / L 60-75% on dark) with warm-leaning
    hues, so they read as one family instead of a stock VS Code spectrum. Every one
    clears 4.5:1 against its theme's editor background, and a test pins the envelope.
  - **`Kbd`'s `onFill` chip is a white scrim,** not `bg-blue` — it was invisible while
    primary was also blue and became a blue tile on a red button the moment primary
    moved to the brand.
  - **Self-hosted fonts.** Hanken Grotesk and JetBrains Mono were named in
    `globals.css` but shipped nowhere, so the app silently rendered in `system-ui`
    everywhere. Both now bundle as variable woff2 via `@fontsource-variable/*`.
  - **A new loading screen** — the brand mark run through a Paper Design `Heatmap`
    shader, with per-ground prop sets and static fallbacks for `prefers-reduced-motion`
    and renderers without WebGL. Replaces the rocket-emoji splash.
  - **The real mark** replaces the `✦` placeholder on the auth card, first-run screen,
    empty state, component library and provider list.
  - **The splash runs the shader full-bleed** on its own `colorBack`, so there is no
    visible tile edge — matching the page colour alone was not enough, because the
    shader's grain lifts its rectangle above a flat fill.
  - **The sign-in wall lost its starfield** for a flat canvas and the card's brand
    halo. A starfield said nothing about Jingler.
  - **The brand mark is in the title bar**, centred with the window title.
  - `docs/brand.md` writes the rules down; a `Brand` Storybook page renders them live.

### Patch Changes

- Updated dependencies [3deb8c2]
- Updated dependencies [fa256c7]
- Updated dependencies [f948464]
- Updated dependencies [1eed467]
- Updated dependencies [20971db]
- Updated dependencies [f8760cf]
- Updated dependencies [c1a3c18]
- Updated dependencies [d6dbd48]
- Updated dependencies [59305ae]
- Updated dependencies [272f34a]
- Updated dependencies [142c0fe]
- Updated dependencies [42780c5]
- Updated dependencies [f842e84]
- Updated dependencies [37c10d5]
- Updated dependencies [ce51af4]
- Updated dependencies [af42847]
- Updated dependencies [eb62eb6]
- Updated dependencies [f3bb880]
- Updated dependencies [d11dbf0]
- Updated dependencies [a0292a3]
- Updated dependencies [abec0fa]
- Updated dependencies [09f4690]
- Updated dependencies [334ebfc]
- Updated dependencies [777d6d2]
- Updated dependencies [9e2539d]
- Updated dependencies [9e2539d]
- Updated dependencies [b79346f]
- Updated dependencies [304ac26]
- Updated dependencies [b419734]
- Updated dependencies [f987c20]
- Updated dependencies [e98acda]
  - @jingler/core@2.0.0

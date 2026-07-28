import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DEFAULT_THEME_ID } from "@jingler/core"

/**
 * Both fallback palettes, asserted against `DEFAULT_THEME_ID`.
 *
 * There are two places that hardcode a preset rather than resolving one, and
 * they are the two that run before anything is resolvable: `main/boot-theme.ts`
 * paints before React mounts, and `renderer/use-theme.ts` is the context value
 * while config and catalog are still in flight (and the one a deleted or
 * malformed active theme falls back to).
 *
 * This exists because moving the default left the renderer on One Dark Pro. The
 * app looked right — the boot stylesheet was correct and the catalog overwrote
 * the fallback a beat later — but `LoadingScreen` reads `tokens.kind` off that
 * fallback to pick the shader's ground, so a LIGHT install flashed a full-bleed
 * dark splash over its light boot stylesheet on every launch: exactly the flash
 * `boot-theme.ts` exists to kill, just moved past the point anyone was looking.
 *
 * A string check is the only cheap thing that catches it, because both files
 * are correct TypeScript with the wrong preset in them.
 */

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

/** "jingler-dark" → "jinglerDark", the preset's export name in @jingler/themes. */
const presetExport = (id: string): string =>
  id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

describe("theme fallbacks track DEFAULT_THEME_ID", () => {
  const preset = presetExport(DEFAULT_THEME_ID)

  it.each([
    ["renderer/use-theme.ts", "./use-theme.ts"],
    ["main/boot-theme.ts", "../main/boot-theme.ts"]
  ])("%s falls back to the default preset", (_label, path) => {
    const text = source(path)
    expect(text).toMatch(new RegExp(`toTokens\\(${preset}\\)`))
    // Not merely "mentions the right one" — no OTHER preset may be the fallback.
    expect(text.match(/toTokens\(([A-Za-z]+)\)/g)).toEqual([`toTokens(${preset})`])
  })
})

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
// @ts-expect-error — vite.mjs is plain JS whose only types are the hand-written
// vite.d.ts this test exists to check. Importing it *through* those types would
// make the test assert the declaration against itself.
import { STARBASE_EXTERNALS } from "../vite.mjs"

/**
 * `STARBASE_EXTERNALS` exists three times, by hand, and this is what makes that
 * safe.
 *
 * The list of specifiers Starbase provides at runtime is written out in:
 *
 *   1. `vite.mjs`      — the runtime array a plugin's build actually consumes
 *   2. `vite.d.ts`     — a hand-written tuple, because `vite.mjs` is plain JS
 *   3. `api-digest.md` — the page an author reads instead of the source
 *
 * ## Why three, and why none of them can be generated away
 *
 * `vite.mjs` is `.mjs` on purpose: a plugin's `vite.config.ts` imports it while
 * Vite is still bootstrapping, before any TypeScript transform is available, so
 * it cannot be a `.ts` file compiled at build time. That forces a separate
 * `.d.ts`, and a `.d.ts` beside a `.mjs` is hand-written by definition —
 * `tsc` has nothing to emit it from.
 *
 * ## Why a tuple rather than `readonly string[]`
 *
 * The literal tuple is the point: it lets an author write
 * `STARBASE_EXTERNALS[5]` or spread it into a config and have the compiler know
 * the members. That value is exactly what makes drift expensive — a tuple that
 * disagrees with runtime gives a compile-time picture of a runtime that is not
 * there, and the mistake shows up as a plugin that bundles something Starbase
 * also provides.
 *
 * That is the same trade `ui-exports.ts` makes, and it is acceptable for the same
 * reason: a test that fails the moment the copies disagree. This file is that
 * test. Adding a specifier means adding it in all three places; this says so, by
 * name, in whichever one you forgot.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/**
 * Pull the quoted strings out of a `STARBASE_EXTERNALS` declaration.
 *
 * Text, not `import`: `vite.d.ts` is a type declaration with no runtime value,
 * and the whole question is whether the text a human maintains matches the array
 * a build consumes. Parsing is the only way to ask it.
 */
const listedIn = (source: string, after: RegExp): ReadonlyArray<string> => {
  const start = source.match(after)
  if (start?.index === undefined) {
    throw new Error(`Could not find a STARBASE_EXTERNALS declaration matching ${after}`)
  }
  const from = source.slice(start.index + start[0].length)
  const block = from.slice(0, from.indexOf("]"))
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
}

const runtime: ReadonlyArray<string> = STARBASE_EXTERNALS

const declared = listedIn(read("../vite.d.ts"), /export declare const STARBASE_EXTERNALS[^[]*\[/)

const documented = listedIn(read("../api-digest.md"), /const STARBASE_EXTERNALS[^[]*\[/)

describe("STARBASE_EXTERNALS", () => {
  it("declares in vite.d.ts exactly what vite.mjs provides at runtime", () => {
    // Order-sensitive, unlike the ui-exports test: this is a TUPLE, so index 5
    // is part of its type. Two lists with the same members in a different order
    // are a real mismatch here.
    expect(declared, "vite.d.ts vs vite.mjs").toEqual([...runtime])
  })

  it("documents in api-digest.md exactly what vite.mjs provides", () => {
    // The digest is where an author looks when deciding what to externalise, so
    // a missing entry there costs them a bundled React just as surely as a
    // missing entry in the config would.
    expect([...documented].sort(), "api-digest.md vs vite.mjs").toEqual([...runtime].sort())
  })

  it("still provides the SDK's own two entrypoints", () => {
    // Pinned by name because these are the two that have actually drifted. The
    // `/ui` subpath was added to the kit and to `vite.mjs` and initially missed
    // in `vite.d.ts` and the digest — a plugin importing the themed components
    // then bundled a second copy of every one of them.
    expect(runtime).toContain("@starbase/plugin-sdk")
    expect(runtime).toContain("@starbase/plugin-sdk/ui")
  })

  it("has no duplicates, which would silently pass the comparisons above", () => {
    expect([...new Set(runtime)]).toHaveLength(runtime.length)
  })
})

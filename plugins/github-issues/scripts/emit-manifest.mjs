/**
 * Write `jingler.plugin.json` from the TypeScript manifest.
 *
 * The manifest is authored in TS so `definePlugin` can check the views against
 * its contribution ids. Jingler reads JSON. Generating one from the other is
 * what keeps a single source of truth — a hand-maintained JSON copy would drift
 * the first time someone renamed a tab.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { manifest } from "../src/manifest.ts"

const out = fileURLToPath(new URL("../jingler.plugin.json", import.meta.url))
const withSchema = {
  $schema: "../../../packages/plugin-sdk/jingler.plugin.schema.json",
  ...manifest
}
writeFileSync(out, `${JSON.stringify(withSchema, null, 2)}\n`, "utf8")
console.log(`Wrote ${out}`)

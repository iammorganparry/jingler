/**
 * Generate `starbase.plugin.schema.json` from the Effect Schema in
 * `@starbase/core`.
 *
 * ## Why generated rather than hand-written
 *
 * There are three descriptions of a plugin manifest and they must not drift:
 * the Effect Schema the loader validates against, the TypeScript types a plugin
 * author writes with, and the JSON Schema their editor uses for completion.
 * Hand-writing the third guarantees it falls behind the first — usually at the
 * moment someone adds a field, which is exactly when an author most wants the
 * editor's help.
 *
 * Deriving it means a manifest with `"$schema": "..."` gets validation and
 * autocomplete in VS Code, Zed, or anything else that speaks JSON Schema, with
 * no Starbase-specific tooling installed.
 *
 * Run with `pnpm --filter @starbase/plugin-sdk gen:schema` (tsx resolves the
 * TypeScript import).
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { JSONSchema } from "effect"
import { PluginManifest } from "../packages/core/src/plugin.ts"

const OUT = fileURLToPath(
  new URL("../packages/plugin-sdk/starbase.plugin.schema.json", import.meta.url)
)

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Starbase plugin manifest",
  description:
    "The contents of a plugin's starbase.plugin.json. Generated from @starbase/core — do not edit by hand.",
  ...JSONSchema.make(PluginManifest)
}

writeFileSync(OUT, `${JSON.stringify(schema, null, 2)}\n`, "utf8")
console.log(`Wrote ${OUT}`)

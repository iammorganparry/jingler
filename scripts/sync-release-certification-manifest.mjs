import { readFile, writeFile } from "node:fs/promises"

const versionsFile = new URL(
  "../packages/core/src/runtime/runtime-contract-versions.json",
  import.meta.url
)
const manifestFile = new URL(
  "../packages/core/src/runtime/release-certification-manifest.json",
  import.meta.url
)

const versions = JSON.parse(await readFile(versionsFile, "utf8"))
const expected = `${JSON.stringify({
  format: "jingler-release-certification-manifest-v1",
  schemaVersion: 1,
  generatedAt: "1970-01-01T00:00:00.000Z",
  versions,
  requiredScenarioIds: [],
  models: []
}, null, 2)}\n`

if (process.argv.includes("--check")) {
  const actual = await readFile(manifestFile, "utf8")
  if (actual !== expected) {
    throw new Error(
      "The development release certification manifest is stale. Run pnpm runtime-contracts:sync."
    )
  }
} else {
  await writeFile(manifestFile, expected, "utf8")
}

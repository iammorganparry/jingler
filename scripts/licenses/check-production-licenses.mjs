import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  inspectProductionLicenses,
  piAttributionIssues
} from "./production-license-policy.mjs"

const root = resolve(import.meta.dirname, "../..")
const report = await inspectProductionLicenses(root)
const notices = await readFile(resolve(root, "THIRD-PARTY-LICENSES"), "utf8")
const issues = [...report.issues, ...piAttributionIssues(notices, report.packages)]

if (issues.length > 0) {
  process.stderr.write(`${issues.join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${report.packages.length} production packages satisfy license policy\n`)
}

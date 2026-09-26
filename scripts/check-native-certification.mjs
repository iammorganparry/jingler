import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

function validateRecord(record, commit, matrix) {
    if (record.schemaVersion !== 1 || record.commit !== commit || record.status !== "passed" || !/^\d+\.\d+\.\d+$/.test(record.cliVersion) || !Number.isFinite(Date.parse(record.timestamp))) throw new Error("Invalid certification")
    if (record.version === "minimum" && record.cliVersion !== matrix[record.runtime].minimum) throw new Error("Wrong minimum version")
    if (JSON.stringify(record.checks) !== JSON.stringify(["discovery", "prompt", "resume"])) throw new Error("Missing live checks")
}

export function validateNativeCertifications(records, commit, matrix) {
  if (!/^[a-f0-9]{40}$/.test(commit) || records.length !== 6) throw new Error("Expected six same-commit certifications")
  const seen = new Set()
  for (const record of records) {
    const keys = ["checks", "cliVersion", "commit", "runtime", "schemaVersion", "status", "timestamp", "version"]
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) throw new Error("Unexpected artifact fields")
    if (!Object.hasOwn(matrix, record.runtime) || !["minimum", "current"].includes(record.version)) throw new Error("Unexpected matrix cell")
    const cell = `${record.runtime}-${record.version}`
    if (seen.has(cell)) throw new Error("Duplicate matrix cell")
    seen.add(cell)
    validateRecord(record, commit, matrix)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, commit] = process.argv.slice(2)
  const matrix = JSON.parse(readFileSync(new URL("../config/native-runtime-certification.json", import.meta.url), "utf8"))
  const records = Object.keys(matrix).flatMap(runtime => ["minimum", "current"].map(version => JSON.parse(readFileSync(resolve(directory, `${runtime}-${version}.json`), "utf8"))))
  validateNativeCertifications(records, commit, matrix)
  console.log("Six same-commit native certifications passed")
}

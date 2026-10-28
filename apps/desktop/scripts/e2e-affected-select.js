/**
 * Pure path→spec selection for `e2e:affected`. Every changed path either
 * forces the full suite, selects specs from affected-map.json, or is inert.
 * Anything we cannot classify runs everything: a missed spec is worse than a
 * slow run.
 */
const RUN_ALL_PATHS = [
  /^pnpm-lock\.yaml$/,
  /(^|\/)package\.json$/,
  /(^|\/)playwright\.config\.[cm]?[jt]s$/,
  /^apps\/desktop\/e2e\/fixtures\.ts$/,
  /^apps\/desktop\/src\/main\/e2e\//,
  /^apps\/desktop\/e2e\/affected-map\.json$/
]
const SPEC_FILE = /^apps\/desktop\/e2e\/([^/]+\.spec\.ts)$/
// Docs, markdown outside source, and unit tests/stories never reach the built app.
const isInert = (path) =>
  path.startsWith("docs/") ||
  (path.endsWith(".md") && !path.includes("/src/")) ||
  /\.(test|stories)\.tsx?$/.test(path)

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, "(?:.*/)?")}`
  )

/** A pattern with `*` is a glob; otherwise it is a plain path prefix. */
export const matchesPattern = (pattern, path) =>
  pattern.includes("*") ? globToRegExp(pattern).test(path) : path.startsWith(pattern)

const mapMatches = (path, map) =>
  map.flatMap((entry) => {
    const pattern = entry.paths.find((candidate) => matchesPattern(candidate, path))
    return pattern === undefined ? [] : [{ pattern, specs: entry.specs }]
  })

const runAll = (allSpecs, why) => ({ specs: [...allSpecs], reason: [`running every spec: ${why}`] })

/** @returns {{ specs: string[], reason: string[] }} */
export const selectSpecs = (changedFiles, map, allSpecs) => {
  const selected = new Set()
  const reason = []
  for (const path of changedFiles) {
    if (RUN_ALL_PATHS.some((pattern) => pattern.test(path))) return runAll(allSpecs, `${path} affects every spec`)
    const spec = SPEC_FILE.exec(path)
    if (spec) {
      selected.add(spec[1])
      reason.push(`${path} is a spec: runs itself`)
      continue
    }
    if (isInert(path)) continue
    const hits = mapMatches(path, map)
    if (hits.length === 0) return runAll(allSpecs, `${path} matches no affected-map entry`)
    for (const { pattern, specs } of hits) {
      for (const name of specs) selected.add(name)
      reason.push(`${path} matched "${pattern}": ${specs.join(", ")}`)
    }
  }
  return { specs: allSpecs.filter((name) => selected.has(name)), reason }
}

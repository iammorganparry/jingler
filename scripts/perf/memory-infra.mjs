/**
 * Summarize a Chromium memory-infra trace (what `pnpm perf memory-dump`
 * captures through Electron's contentTracing) into a per-process allocator
 * report. Pure: no I/O, so it is unit-testable and usable on any saved trace.
 *
 * Trace shape (the parts we read):
 *   - `ph: "M"` metadata events named `process_name` / `process_labels`
 *   - `ph: "v"` memory dump events: `args.dumps.allocators` is a flat map of
 *     slash-separated allocator paths → `{ attrs: { size, object_count, … } }`
 *     with hex-string values, and `args.dumps.process_totals` carries RSS and
 *     private footprint. A trace with several dumps yields one `ph: "v"` per
 *     process per dump, all sharing the dump `id`.
 *
 * Sizes on parent paths already include their children (Chromium reports
 * `partition_alloc/partitions/buffer` as the whole partition), so the report
 * shows a shallow tree rather than summing leaves.
 */

const ISOLATE_PATH = /^v8\/[^/]+$/
const BLINK_OBJECTS_PREFIX = "blink_objects/"

const hex = (value) => (typeof value === "string" ? Number.parseInt(value, 16) : Number(value ?? 0))

const depthOf = (path) => path.split("/").length

/** Metadata + memory-dump events, grouped by pid. */
const collectDumps = (events) => {
  const names = new Map()
  const labels = new Map()
  const dumpsByPid = new Map()
  for (const event of events) {
    if (event.ph === "M" && event.name === "process_name") names.set(event.pid, event.args?.name ?? "")
    if (event.ph === "M" && event.name === "process_labels") labels.set(event.pid, event.args?.labels ?? "")
    if (event.ph !== "v" || !event.args?.dumps) continue
    const list = dumpsByPid.get(event.pid) ?? []
    list.push({ ts: event.ts, dumps: event.args.dumps })
    dumpsByPid.set(event.pid, list)
  }
  for (const list of dumpsByPid.values()) list.sort((a, b) => a.ts - b.ts)
  return { names, labels, dumpsByPid }
}

/** allocator path → { size, objects } for one dump. */
const sizesOf = (dump) => {
  const out = new Map()
  for (const [path, node] of Object.entries(dump.allocators ?? {})) {
    out.set(path, {
      size: hex(node.attrs?.size?.value),
      objects: node.attrs?.object_count ? hex(node.attrs.object_count.value) : undefined
    })
  }
  return out
}

const allocatorRows = (first, last) => {
  const firstSizes = first === last ? null : sizesOf(first.dumps)
  return [...sizesOf(last.dumps)]
    .map(([path, { size, objects }]) => ({
      path,
      size,
      objects,
      delta: firstSizes ? size - (firstSizes.get(path)?.size ?? 0) : undefined
    }))
    .sort((a, b) => b.size - a.size)
}

const summarizeProcess = (pid, list, names, labels) => {
  // Tracing emits an empty allocator map for a process at start-up; Δ against
  // that would just restate the size. Compare with the first REAL dump.
  const withAllocators = list.filter((entry) => Object.keys(entry.dumps.allocators ?? {}).length > 0)
  const first = withAllocators[0] ?? list[0]
  const last = withAllocators[withAllocators.length - 1] ?? list[list.length - 1]
  const allocators = allocatorRows(first, last)
  const totals = last.dumps.process_totals ?? {}
  return {
    pid,
    name: names.get(pid) ?? "",
    label: labels.get(pid) ?? "",
    dumps: withAllocators.length || list.length,
    spanMs: Math.round((last.ts - first.ts) / 1000),
    residentBytes: hex(totals.resident_set_bytes),
    privateFootprintBytes: hex(totals.private_footprint_bytes),
    allocators,
    blinkObjects: allocators
      .filter((a) => a.path.startsWith(BLINK_OBJECTS_PREFIX) && a.objects !== undefined)
      .map((a) => ({ path: a.path.slice(BLINK_OBJECTS_PREFIX.length), objects: a.objects }))
      .sort((a, b) => b.objects - a.objects),
    isolates: allocators.filter((a) => ISOLATE_PATH.test(a.path)).length
  }
}

/** Per-process last-dump state (and first-dump sizes for deltas). */
export const summarizeMemoryInfra = (trace) => {
  const events = Array.isArray(trace) ? trace : (trace?.traceEvents ?? [])
  const { names, labels, dumpsByPid } = collectDumps(events)
  const processes = [...dumpsByPid].map(([pid, list]) => summarizeProcess(pid, list, names, labels))
  processes.sort((a, b) => b.privateFootprintBytes - a.privateFootprintBytes)
  return { processes }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`
const signedMb = (bytes) => `${bytes >= 0 ? "+" : ""}${mb(bytes)}`

const processHeading = (proc) => {
  const who = [proc.name, proc.label].filter(Boolean).join(" · ") || "process"
  const span = proc.dumps > 1 ? `  (${proc.dumps} dumps over ${(proc.spanMs / 1000).toFixed(0)}s — Δ is last−first)` : ""
  const isolates = proc.isolates > 1 ? `  v8 isolates:${proc.isolates}` : ""
  return `\n=== pid ${proc.pid}  ${who}  footprint:${mb(proc.privateFootprintBytes)}  rss:${mb(proc.residentBytes)}${span}${isolates}`
}

const allocatorLine = (row) => {
  const delta = row.delta === undefined ? "" : signedMb(row.delta).padStart(11)
  const indent = "  ".repeat(depthOf(row.path) - 1)
  const objects = row.objects === undefined ? "" : `  (${row.objects} objects)`
  return `  ${mb(row.size).padStart(10)}${delta}  ${indent}${row.path}${objects}`
}

export const printMemoryReport = (report, { top = 25, maxDepth = 3, minBytes = 1048576 } = {}) => {
  if (report.processes.length === 0) {
    console.log("no memory dumps in trace — is the disabled-by-default-memory-infra category available?")
    return
  }
  for (const proc of report.processes) {
    console.log(processHeading(proc))
    const rows = proc.allocators
      .filter((a) => !a.path.startsWith(BLINK_OBJECTS_PREFIX) && depthOf(a.path) <= maxDepth && a.size >= minBytes)
      .slice(0, top)
    for (const row of rows) console.log(allocatorLine(row))
    const objects = proc.blinkObjects.slice(0, 12)
    if (objects.length > 0) {
      console.log(`  blink objects: ${objects.map((o) => `${o.path}=${o.objects}`).join("  ")}`)
    }
  }
}

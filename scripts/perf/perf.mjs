#!/usr/bin/env node
/**
 * `pnpm perf <command>` — agent CLI for the dev-mode performance monitor.
 *
 * Talks to the loopback HTTP API the dev app serves (apps/desktop/src/main/
 * perf-api.ts), discovered through `~/jingler/diagnostics/perf/endpoint.json`
 * (respects JINGLER_HOME). Requires the dev app to be running (`pnpm dev`).
 *
 * Commands:
 *   status                       monitor health + whether CDP is attached
 *   metrics                      one fresh sample (JSON)
 *   watch [--interval s]         live one-line table of the key counters
 *   history [--limit N] [--json] recent samples + leak-trend verdict
 *   snapshot [--label x]         heap snapshot → prints .heapsnapshot path
 *   cpu-profile [seconds]        CPU profile → prints .cpuprofile path
 *   alloc [seconds]              allocation-site sampling → prints path
 *   renders start|stop|report    React render tracking (react-scan)
 *   leak-check [--warmup s]      3-snapshot memlab protocol; repro during warmup
 *   analyze <workdir|snapshot>   run memlab analyses (needs npx memlab)
 *   memory-dump [--dumps N] [--interval s] [--json] [--top N]
 *                                memory-infra trace: per-process allocator
 *                                breakdown (PartitionAlloc, Oilpan, V8 per
 *                                isolate, Skia, caches) + blink object counts.
 *                                Works with DevTools open / CDP wedged.
 *   memory-report <trace.json>   summarize an existing memory-infra trace
 *
 * memlab is invoked via npx on demand — it is deliberately NOT a repo
 * dependency (heavy, CLI-only, never runs inside the app).
 */
import { spawnSync } from "node:child_process"
import { readFileSync, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { detectTrends } from "./trend.mjs"
import { printMemoryReport, summarizeMemoryInfra } from "./memory-infra.mjs"

// biome-ignore lint/suspicious/noUndeclaredEnvVars: JINGLER_HOME is the app-wide root override (see main/app-paths.ts), read here outside any turbo task — declaring it in turbo.json would invalidate every task's cache for a CLI-only variable.
const jinglerRoot = join(process.env.JINGLER_HOME ?? homedir(), "jingler")
const perfRoot = join(jinglerRoot, "diagnostics", "perf")
const endpointFile = join(perfRoot, "endpoint.json")

const die = (message) => {
  console.error(message)
  process.exit(1)
}

const endpoint = () => {
  if (!existsSync(endpointFile)) {
    die(
      `No perf endpoint at ${endpointFile}.\nIs the dev app running? Start it with: pnpm dev\n(The monitor only runs in dev builds; JINGLER_PERF_MONITOR=0 disables it.)`
    )
  }
  const parsed = JSON.parse(readFileSync(endpointFile, "utf8"))
  // A crashed/killed app never runs its will-quit cleanup, so the discovery
  // file can outlive the process. Probe the recorded pid before trusting it.
  try {
    process.kill(parsed.pid, 0)
  } catch {
    die(
      `Stale perf endpoint: the app that wrote ${endpointFile} (pid ${parsed.pid}) is gone.\nRestart the dev app (pnpm dev); it rewrites the endpoint on boot.`
    )
  }
  return parsed
}

const api = async (method, path, body) => {
  const { port, token } = endpoint()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).catch((cause) => die(`Cannot reach the perf monitor on port ${port}: ${cause.message}\nThe app may have restarted — endpoint.json goes stale; restart pnpm dev or check status.`))
  const json = await response.json()
  if (!response.ok) die(`${method} ${path} → ${response.status}: ${json.error ?? "unknown error"}`)
  return json
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`
const kbToMb = (kb) => `${(kb / 1024).toFixed(0)}MB`

const sampleLine = (s) => {
  // The app window's renderer by pid; older samples (no rendererPid) fall back
  // to the first Tab, which may be a native preview view.
  const renderer =
    s.processes?.find((p) => s.rendererPid !== undefined && p.pid === s.rendererPid) ??
    s.processes?.find((p) => p.type === "Tab")
  const parts = [
    new Date(s.t).toTimeString().slice(0, 8),
    `rss:${mb(s.main.rss)}`,
    renderer ? `renderer:${kbToMb(renderer.workingSetKb)} cpu:${renderer.cpuPercent.toFixed(0)}%` : "renderer:n/a"
  ]
  if (s.renderer) {
    parts.push(
      `jsHeap:${mb(s.renderer.usedSize)}`,
      `blinkHeap:${mb(s.renderer.embedderHeapUsedSize)}`,
      `nodes:${s.renderer.nodes}`,
      `listeners:${s.renderer.jsEventListeners}`,
      `docs:${s.renderer.documents}`
    )
  }
  if (s.app) {
    parts.push(`actors:${s.app.actors}`, `lagP95:${s.app.loopLagP95}ms`)
    // Running CSS/WAAPI animations. One un-composited animation is enough to
    // keep the main thread painting every frame; the top buckets name it.
    if (typeof s.app.animations === "number") {
      const top = Array.isArray(s.app.animationTop) ? s.app.animationTop.slice(0, 3).join(",") : ""
      parts.push(`anim:${s.app.animations}${top ? ` [${top}]` : ""}`)
    }
  }
  return parts.join("  ")
}

const printVerdict = (result) => {
  console.log(`\nverdict: ${result.verdict}`)
  if (result.detail) console.log(result.detail)
  for (const sig of result.signals) {
    console.log(
      `  ${sig.signal}: ${sig.first} → ${sig.last} (${sig.slopePerMin > 1000 ? mb(sig.slopePerMin) : Math.round(sig.slopePerMin * 100) / 100}/min, r²=${sig.r2})`
    )
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const flag = (args, name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= args.length) return fallback
  return args[index + 1]
}

const runMemlab = (memlabArgs) => {
  const result = spawnSync("npx", ["--yes", "memlab", ...memlabArgs], {
    stdio: "inherit",
    env: process.env
  })
  if (result.error) {
    die(
      `Could not run memlab via npx (${result.error.message}).\nInstall it once with: npm install -g memlab`
    )
  }
  return result.status ?? 1
}

const [, , command = "status", ...args] = process.argv

switch (command) {
  case "status": {
    console.log(JSON.stringify(await api("GET", "/status"), null, 2))
    break
  }
  case "metrics": {
    console.log(JSON.stringify(await api("GET", "/metrics"), null, 2))
    break
  }
  case "watch": {
    const intervalS = Number(flag(args, "interval", "10"))
    console.log(`watching (every ${intervalS}s, ctrl-c to stop)…`)
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: a watch loop is sequential by definition — each poll waits out the interval.
      const sample = await api("GET", "/metrics")
      console.log(sampleLine(sample))
      await sleep(intervalS * 1000)
    }
  }
  case "history": {
    const limit = Number(flag(args, "limit", "120"))
    const { samples } = await api("GET", `/history?limit=${limit}`)
    if (args.includes("--json")) {
      console.log(JSON.stringify(samples, null, 2))
      break
    }
    for (const sample of samples.slice(-20)) console.log(sampleLine(sample))
    printVerdict(detectTrends(samples))
    break
  }
  case "snapshot": {
    const label = flag(args, "label", undefined)
    const { path } = await api("POST", "/heap-snapshot", label ? { label } : {})
    console.log(path)
    console.log(`analyze with: pnpm perf analyze ${path}`)
    break
  }
  case "cpu-profile": {
    const seconds = Number(args[0] ?? "15")
    await api("POST", "/cpu-profile/start")
    console.log(`profiling for ${seconds}s…`)
    await sleep(seconds * 1000)
    const { path } = await api("POST", "/cpu-profile/stop")
    console.log(path)
    console.log("open in Chrome DevTools → Performance → load profile")
    break
  }
  case "alloc": {
    const seconds = Number(args[0] ?? "30")
    await api("POST", "/alloc/start")
    console.log(`sampling allocations for ${seconds}s…`)
    await sleep(seconds * 1000)
    const { path } = await api("POST", "/alloc/stop")
    console.log(path)
    console.log("open in Chrome DevTools → Memory → load heap profile (allocation sampling)")
    break
  }
  case "renders": {
    const sub = args[0] ?? "report"
    if (sub === "start") {
      console.log(JSON.stringify(await api("POST", "/renders/start", { showToolbar: args.includes("--toolbar") })))
    } else if (sub === "stop") {
      console.log(JSON.stringify(await api("POST", "/renders/stop")))
    } else {
      const report = await api("GET", "/renders/report")
      if (report.error) die(report.error)
      if (!report.components?.length) {
        console.log("no renders recorded — run `pnpm perf renders start`, exercise the app, then report")
        break
      }
      console.log("component                                    renders  unnecessary  total-ms")
      for (const c of report.components.slice(0, 30)) {
        console.log(`${c.name.padEnd(45).slice(0, 45)}${String(c.count).padStart(7)}${String(c.unnecessary).padStart(13)}${String(c.totalTimeMs).padStart(10)}`)
      }
    }
    break
  }
  case "leak-check": {
    const warmup = Number(flag(args, "warmup", "30"))
    console.log(
      `Taking baseline snapshot, then you have ${warmup}s to REPRODUCE the suspected leak\n(interact with the app / run the agent turn / open-close the surface)…`
    )
    const result = await api("POST", "/leak-check", { warmupMs: warmup * 1000 })
    console.log(`snapshots written under ${result.workdir}`)
    console.log("running memlab find-leaks…")
    runMemlab(["find-leaks", "--work-dir", result.workdir])
    break
  }
  case "memory-dump": {
    const dumps = Number(flag(args, "dumps", "1"))
    const intervalMs = Number(flag(args, "interval", "2")) * 1000
    console.log(`capturing ${dumps} detailed memory-infra dump${dumps === 1 ? "" : "s"} (≈${Math.round((intervalMs * dumps) / 1000) + 2}s)…`)
    const { path } = await api("POST", "/memory-dump", { dumps, intervalMs })
    console.log(path)
    const report = summarizeMemoryInfra(JSON.parse(readFileSync(path, "utf8")))
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2))
    else printMemoryReport(report, { top: Number(flag(args, "top", "25")) })
    break
  }
  case "memory-report": {
    const target = args[0]
    if (!target) die("usage: pnpm perf memory-report <trace.memory-infra.json>")
    if (!existsSync(target)) die(`no such path: ${target}`)
    const report = summarizeMemoryInfra(JSON.parse(readFileSync(target, "utf8")))
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2))
    else printMemoryReport(report, { top: Number(flag(args, "top", "25")) })
    break
  }
  case "analyze": {
    const target = args[0]
    if (!target) die("usage: pnpm perf analyze <workdir|snapshot.heapsnapshot>")
    if (!existsSync(target)) die(`no such path: ${target}`)
    if (statSync(target).isDirectory()) {
      runMemlab(["find-leaks", "--work-dir", target])
    } else {
      // A lone snapshot has no series for the unbound-* analyses (they need
      // memlab's own snap-seq meta and die with "snapshot meta data invalid");
      // detached-DOM and shape both read a single --snapshot file.
      runMemlab(["analyze", "detached-DOM", "--snapshot", target])
      runMemlab(["analyze", "shape", "--snapshot", target])
    }
    break
  }
  default:
    die(`unknown command: ${command}\ncommands: status metrics watch history snapshot cpu-profile alloc renders leak-check analyze memory-dump memory-report`)
}

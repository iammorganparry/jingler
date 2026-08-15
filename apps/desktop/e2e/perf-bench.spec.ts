import { existsSync, readFileSync } from "node:fs";
import { expect, sessionRow, test } from "./fixtures.js";
import type { SeedSession } from "./fixtures.js";

/**
 * PERFORMANCE BENCH, not a regression test. Loads a real heavy transcript
 * (copied from the developer's ~/jingler) into an isolated JINGLER_HOME,
 * opens the session, and reports hard numbers: time to first transcript rows,
 * renderer long tasks during the load, and a CPU profile of where the time
 * went. Skips when the heavy transcript is absent (any other machine).
 */
const HEAVY_TRANSCRIPT =
  process.env.JINGLER_BENCH_TRANSCRIPT ??
  "/Users/morganparry/jingler/transcripts/c_s_hidden-franklin_1.json";

const seed: SeedSession = {
  id: "s_bench",
  repo: "widget",
  branch: "chore/bench",
  title: "Bench Heavy",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-16T00:00:00.000Z",
};

test("bench: heavy conversation load", async ({ launchApp }) => {
  test.skip(!existsSync(HEAVY_TRANSCRIPT), "heavy transcript not present");
  test.setTimeout(300_000);
  const messages = JSON.parse(readFileSync(HEAVY_TRANSCRIPT, "utf8"));
  console.log(`BENCH transcript: ${messages.length} messages, ${(readFileSync(HEAVY_TRANSCRIPT, "utf8").length / 1e6).toFixed(1)}MB`);

  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [seed],
    transcripts: { s_bench: messages },
  });

  await window.evaluate(() => {
    const tasks: Array<{ start: number; dur: number }> = [];
    (window as unknown as Record<string, unknown>).__longTasks = tasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push({ start: entry.startTime, dur: entry.duration });
      }
    }).observe({ entryTypes: ["longtask"] });
  });

  const cdp = await window.context().newCDPSession(window);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

  // Wait out the boot splash FIRST — `click()` auto-waits for the row, so
  // marking t0 before the row exists would fold boot (and its WebGL shader
  // splash) into the numbers.
  const row = sessionRow(window, "Bench Heavy");
  await expect(row).toBeVisible({ timeout: 60_000 });
  await window.waitForTimeout(500);
  const clickAt = await window.evaluate(() => performance.now());
  await cdp.send("Profiler.start");
  const t0 = Date.now();
  await row.click();
  await expect(window.getByTestId("conversation-scroll")).toBeVisible({
    timeout: 240_000,
  });
  const tScroll = Date.now() - t0;
  await expect(window.locator("[data-index]").first()).toBeVisible({
    timeout: 240_000,
  });
  const tRows = Date.now() - t0;

  // Let rendering settle, then measure steady-state responsiveness.
  await window.waitForTimeout(4_000);
  const raf = await window.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const t = performance.now();
        requestAnimationFrame(() => resolve(performance.now() - t));
      }),
  );

  const { profile } = await cdp.send("Profiler.stop");
  const allTasks = await window.evaluate(
    () => (window as unknown as Record<string, unknown>).__longTasks,
  ) as Array<{ start: number; dur: number }>;
  const longTasks = allTasks.filter((t) => t.start >= clickAt);
  const domStats = await window.evaluate(() => {
    const all = document.querySelectorAll("*");
    let grids = 0;
    for (const el of all) {
      if (getComputedStyle(el).display.includes("grid")) grids++;
    }
    return { nodes: all.length, grids };
  });
  console.log(`DOM after settle: ${domStats.nodes} elements, ${domStats.grids} grid elements`);

  const scrollState = await window.evaluate(() => {
    const el = document.querySelector('[data-testid="conversation-scroll"]');
    if (!(el instanceof HTMLElement)) return null;
    const box = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("[data-index]")];
    const visible = rows
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      })
      .map((row) => row.getAttribute("data-index"));
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      distanceToBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      visibleRows: visible,
    };
  });
  console.log(`scroll after settle: ${JSON.stringify(scrollState)}`);

  // Aggregate self time per function from the sampled profile.
  const nodesById = new Map<number, { name: string; url: string; line: number; hits: number }>();
  for (const node of profile.nodes) {
    nodesById.set(node.id, {
      name: node.callFrame.functionName || "(anonymous)",
      url: (node.callFrame.url || "").split("/").slice(-2).join("/"),
      line: node.callFrame.lineNumber,
      hits: node.hitCount ?? 0,
    });
  }
  const totalHits = [...nodesById.values()].reduce((a, n) => a + n.hits, 0);
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  const byFn = new Map<string, number>();
  for (const node of nodesById.values()) {
    if (node.hits === 0) continue;
    const key = `${node.name} @ ${node.url}:${node.line}`;
    byFn.set(key, (byFn.get(key) ?? 0) + node.hits);
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);

  // ── Phase 2: page the mega-turn in — the "load more" spike path. ──────────
  const heapBefore = await window.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );
  const loadAt = await window.evaluate(() => performance.now());
  const tLoad0 = Date.now();
  await window.getByTestId("load-earlier").click();
  // The mega-turn (669 parts) arrives collapsed — its expander is the signal
  // that the page landed and rendered.
  await expect(window.getByTestId("show-earlier-steps")).toBeVisible({
    timeout: 240_000,
  });
  const tLoadEarlier = Date.now() - tLoad0;
  await window.waitForTimeout(4_000);
  const heapAfter = await window.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );
  const domAfterLoad = await window.evaluate(
    () => document.querySelectorAll("*").length,
  );
  const loadTasks = (await window.evaluate(
    () => (window as unknown as Record<string, unknown>).__longTasks,
  ) as Array<{ start: number; dur: number }>).filter((t) => t.start >= loadAt);

  console.log("BENCH RESULTS ======================================");
  console.log(
    `LOAD-EARLIER: ${tLoadEarlier}ms to render; heap ${(heapBefore / 1e6).toFixed(0)}MB → ${(heapAfter / 1e6).toFixed(0)}MB; DOM ${domAfterLoad} elements; long tasks ${loadTasks.length} totaling ${Math.round(loadTasks.reduce((a, t) => a + t.dur, 0))}ms (worst ${Math.round(Math.max(0, ...loadTasks.map((t) => t.dur)))}ms)`,
  );
  console.log(`time to conversation-scroll visible: ${tScroll}ms`);
  console.log(`time to first transcript row:        ${tRows}ms`);
  console.log(`post-settle rAF latency:             ${raf.toFixed(1)}ms`);
  const totalLong = longTasks.reduce((a, t) => a + t.dur, 0);
  console.log(
    `long tasks: ${longTasks.length} totaling ${Math.round(totalLong)}ms; worst: ${Math.round(Math.max(0, ...longTasks.map((t) => t.dur)))}ms`,
  );
  console.log(`profile window ${Math.round(durationMs)}ms, samples≈${totalHits}`);
  console.log("top self-time functions (self-ms est):");
  for (const [key, hits] of top) {
    const ms = (hits / totalHits) * durationMs;
    if (ms < 5) break;
    console.log(`  ${Math.round(ms).toString().padStart(6)}ms  ${key}`);
  }
  console.log("====================================================");
});

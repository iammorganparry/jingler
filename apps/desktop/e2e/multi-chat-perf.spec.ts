import { measureSessionSwitch } from "./session-switch-latency.js"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"
import type { Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"

const timestamp = "2026-07-24T10:00:00.000Z"
const chats = Array.from({ length: 6 }, (_, i) => ({
  id: `c_stress_${i}`,
  title: i === 0 ? "Main stress" : `Stress ${i}`,
  createdAt: timestamp,
  updatedAt: timestamp
}))
const seed: SeedSession = {
  id: "s_stress", repo: "widget", branch: "chore/stress", title: "Multi-chat stress",
  status: "idle", diff: { added: 0, removed: 0 }, prNumber: null,
  costUsd: 0, tokens: 0, updatedAt: timestamp, chats, activeChatId: chats[0]!.id
}
const transcripts = Object.fromEntries(chats.map((chat) => [chat.id,
  Array.from({ length: 240 }, (_, i) => ({
    id: `${chat.id}_${i}`, role: i % 2 ? "assistant" : "user", streaming: false,
    createdAt: timestamp,
    parts: [{ _tag: "Text", text: i % 2
      ? `## Review ${i}\n\n**Result:** checked the implementation.\n\n| Case | Result |\n| --- | --- |\n| Normal | Passed |\n| Empty | Passed |\n\n\`\`\`typescript\nexport function total(values: number[]) {\n  return values.reduce((sum, value) => sum + value, 0)\n}\n\`\`\`\n\n- [x] Validate input\n- [x] Run tests\n\n${"Rich transcript paragraph with **emphasis** and `inline code`. ".repeat(12)}`
      : `Check change ${i} in ${chat.title}.` }]
  }))
]))

const measure = (window: Page, sessions = [seed]) => window.evaluate(async (sessions) => {
    const multiple = sessions.length > 1
    const frames: number[] = []
    const actions = multiple ? ["switch-session", "open-chat", "move-pane", "close-pane"] : ["open-chat", "move-pane", "close-pane"]
    const actionFrames = actions.map(() => [] as number[])
    let actionIndex = 0
    const longTasks: number[] = []
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => entry.duration))
    })
    observer.observe({ entryTypes: ["longtask"] })
    let previous = performance.now()
    let handle = 0
    const sample = (now: number) => {
      const delta = now - previous
      if (frames.length > 0) actionFrames[actionIndex]!.push(delta)
      frames.push(delta)
      previous = now
      handle = requestAnimationFrame(sample)
    }
    handle = requestAnimationFrame(sample)
    let maxPanes = 0
    const operations = multiple ? 36 : 24
    let openedChatId = ""
    const paneFor = (chatId: string) => [...document.querySelectorAll<HTMLElement>("[data-surface]")]
      .find((pane) => pane.getClientRects().length > 0 && pane.dataset.surface === JSON.stringify(["chat", chatId, null]))
    const control = (i: number) => {
      const cycle = Math.floor(i / actions.length)
      const session = sessions[cycle % sessions.length]!
      if (actions[actionIndex] === "switch-session") {
        return document.querySelector<HTMLElement>(`[data-testid="session-row-${session.id}"]`)
      }
      if (actions[actionIndex] === "open-chat") {
        const candidates = [...session.chats.slice(3), ...session.chats.slice(1, 3)]
        const chat = [...candidates.slice(cycle % candidates.length), ...candidates.slice(0, cycle % candidates.length)]
          .find((candidate) => !paneFor(candidate.id))
        if (!chat) throw new Error("No unopened benchmark chat")
        openedChatId = chat.id
        return [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.getClientRects().length > 0 && button.textContent === chat.title)
      }
      const pane = paneFor(openedChatId)
      return pane?.querySelector<HTMLButtonElement>(actions[actionIndex] === "move-pane"
        ? 'button[aria-label^="Move pane"][aria-label$=" left"]'
        : 'button[aria-label^="Close pane"]')
    }
    const assertAction = (mainId: string, i: number) => {
      if (!paneFor(mainId)) throw new Error(`Main disappeared at operation ${i}`)
      if (actions[actionIndex] === "switch-session") return
      const visible = paneFor(openedChatId) !== undefined
      if (visible !== (actions[actionIndex] !== "close-pane")) {
        throw new Error(`Benchmark action did not change the expected surface at operation ${i}`)
      }
    }
    for (let i = 0; i < operations; i++) {
      actionIndex = i % actions.length
      const session = sessions[Math.floor(i / actions.length) % sessions.length]!
      const button = control(i)
      if (!button) throw new Error(`Missing benchmark control at operation ${i}`)
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 400))
      assertAction(session.chats[0]!.id, i)
      maxPanes = Math.max(maxPanes, [...document.querySelectorAll("[data-surface-pane-index]")].filter((pane) => pane.getClientRects().length > 0).length)
    }
    cancelAnimationFrame(handle)
    observer.disconnect()
    frames.shift()
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return {
        frames: values.length,
        fps: 1000 * values.length / values.reduce((sum, frame) => sum + frame, 0),
        p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: Math.max(...values),
        overBudget: values.filter((frame) => frame > 1000 / 60 + 1).length
      }
    }
    return {
      operations, ...stats(frames), longTasks, maxPanes,
      actions: Object.fromEntries(actions.map((action, i) => [action, stats(actionFrames[i]!)]))
    }
  }, sessions.map(({ id, chats }) => ({ id, chats })))

test("benchmark rich transcripts while opening, moving and closing chat panes", async ({ launchApp }, testInfo) => {
  test.setTimeout(180_000)
  const { window } = await launchApp({
    configured: true, withRepo: true,
    sessions: ({ repoPath }) => [{ ...seed, worktreePath: repoPath }], transcripts
  })
  await window.evaluate(() => localStorage.setItem("jingler:mcp-import-prompt:v1", "done"))
  await window.reload()
  await sessionRow(window, seed.title).click()
  for (const title of ["Stress 1", "Stress 2"]) {
    await window.getByRole("button", { name: title, exact: true }).click()
  }
  await expect(window.locator('[data-testid="conversation-scroll"]:visible')).toHaveCount(3)
  await expect(window.locator('[data-index]:visible').first()).toBeVisible()
  await window.waitForTimeout(1500)

  const result = await measure(window)
  console.log(`MULTI_CHAT_BENCH ${JSON.stringify(result)}`)
  await testInfo.attach("multi-chat-frame-times.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" })
  expect(result.maxPanes).toBeLessThanOrEqual(3)
  const scrolls = window.locator('[data-testid="conversation-scroll"]:visible')
  const history = scrolls.first()
  await history.evaluate((element) => { element.scrollTop = 0 })
  await expect(history.getByText(/^Check change 40 in/)).toBeVisible()
  await history.getByTestId("load-earlier").click()
  await expect(history.getByTestId("load-earlier")).toHaveCount(0)
  await expect(history.getByText(/^Check change 40 in/)).toBeVisible()
  await history.evaluate((element) => { element.scrollTop = 0 })
  await expect(history.getByText(/^Check change 0 in/)).toBeVisible()

  for (let i = 0; i < await scrolls.count(); i++) {
    const scroll = scrolls.nth(i)
    for (const bottom of [false, true, false, true]) {
      await scroll.evaluate((element, bottom) => { element.scrollTop = bottom ? element.scrollHeight : 0 }, bottom)
      await expect.poll(() => scroll.evaluate((element) => {
        const viewport = element.getBoundingClientRect()
        return [...element.querySelectorAll("[data-index]")].some((row) => {
          const bounds = row.getBoundingClientRect()
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom && bounds.height > 0
        })
      })).toBe(true)
    }
  }
})


test("benchmark three running sessions with six rich chat tabs each", async ({ launchApp }, testInfo) => {
  test.setTimeout(240_000)
  const sessions = Array.from({ length: 3 }, (_, i) => ({
    ...seed, id: `s_running_${i}`, title: `Running stress ${i}`,
    chats: chats.map((chat) => ({ ...chat, id: `${chat.id}_session_${i}` })),
    activeChatId: `${chats[0]!.id}_session_${i}`
  }))
  const histories = Object.fromEntries(sessions.flatMap((session) =>
    session.chats.map((chat, i) => [chat.id, transcripts[chats[i]!.id]!])
  ))
  const { window } = await launchApp({
    configured: true, withRepo: true,
    sessions: ({ repoPath }) => sessions.map((session) => ({ ...session, worktreePath: repoPath })),
    transcripts: histories,
    seed: ({ repoPath }) => {
      const directory = join(repoPath, "src", "switch-stress")
      mkdirSync(directory, { recursive: true })
      for (let i = 0; i < 4000; i++) writeFileSync(join(directory, `module-${i}.ts`), `export const value = ${i}\n`)
    }
  })
  await window.evaluate(() => localStorage.setItem("jingler:mcp-import-prompt:v1", "done"))
  await window.reload()
  const firstVisits = []
  for (const session of sessions) {
    firstVisits.push(await measureSessionSwitch(window, session.id, '[data-testid="conversation-scroll"] [data-index]'))
    const active = window.locator(`[data-session="${session.id}"]:visible`)
    const composer = active.getByPlaceholder("Message the agent…")
    await composer.fill("[[queue-hold]] keep this session running during the benchmark")
    await composer.press("Enter")
    await expect(window.locator(`[data-session="${session.id}"]:visible`).getByText("Holding the active turn for queue actions.")).toBeVisible()
  }
  const cachedSwitches = []
  for (let i = 0; i < 12; i++) {
    cachedSwitches.push(await measureSessionSwitch(window, sessions[i % sessions.length]!.id, '[data-testid="conversation-scroll"] [data-index]'))
  }
  console.log(`CACHED_SESSION_SWITCH_LATENCY ${JSON.stringify(cachedSwitches)}`)
  for (const session of sessions) {
    await sessionRow(window, session.title).click()
    for (const title of ["Stress 1", "Stress 2"]) {
      await window.getByRole("button", { name: title, exact: true }).click()
    }
    await expect(window.locator('[data-testid="conversation-scroll"]:visible')).toHaveCount(3)
  }
  const cdp = await window.context().newCDPSession(window)
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.start")
  const repeatSwitches = []
  for (let i = 0; i < 12; i++) {
    repeatSwitches.push(await measureSessionSwitch(window, sessions[i % sessions.length]!.id, '[data-testid="conversation-scroll"] [data-index]'))
  }
  const latency = { firstVisits, cachedSwitches, repeatSwitches }
  console.log(`SESSION_SWITCH_LATENCY ${JSON.stringify(latency)}`)
  await testInfo.attach("session-switch-latency.json", { body: JSON.stringify(latency), contentType: "application/json" })
  const result = await measure(window, sessions)
  const { profile } = await cdp.send("Profiler.stop")
  const profilePath = testInfo.outputPath("multi-session.cpuprofile")
  await writeFile(profilePath, JSON.stringify(profile))
  await testInfo.attach("multi-session.cpuprofile", { path: profilePath, contentType: "application/json" })
  await cdp.send("HeapProfiler.collectGarbage")
  const memory = { ...await cdp.send("Runtime.getHeapUsage"), ...await cdp.send("Memory.getDOMCounters") }
  console.log(`MULTI_SESSION_MEMORY ${JSON.stringify(memory)}`)
  await cdp.detach()
  console.log(`MULTI_SESSION_BENCH ${JSON.stringify(result)}`)
  await testInfo.attach("multi-session-frame-times.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" })
  expect(result.maxPanes).toBeLessThanOrEqual(3)
  for (const session of sessions) {
    await sessionRow(window, session.title).click()
    await expect(window.locator(`[data-session="${session.id}"]:visible`).getByPlaceholder("Queue a message while the agent works…")).toBeVisible()
    await expect(window.locator(`[data-session="${session.id}"]:visible`).getByText("Holding the active turn for queue actions.")).toBeVisible()
    await window.getByRole("button", { name: "Stress 1", exact: true }).click()
    const key = JSON.stringify(["chat", session.chats[1]!.id, null])
    const resumed = window.locator(`[data-session="${session.id}"]:visible [data-surface='${key}']`)
    const composer = resumed.getByPlaceholder("Message the agent…")
    await composer.fill("[[queue-hold]] run again after leaving this chat idle")
    await composer.press("Enter")
    await expect(resumed.getByText("Holding the active turn for queue actions.")).toBeVisible()
  }
  expect([...cachedSwitches].sort((a, b) => a.visibleMs - b.visibleMs)[Math.floor(cachedSwitches.length / 2)]!.visibleMs).toBeLessThan(100)

})

import type { Page } from "@playwright/test"

export const measureSessionSwitch = async (window: Page, sessionId: string, readySelector: string) => {
  await window.getByTestId(`session-row-${sessionId}`).waitFor({ state: "visible" })
  return window.evaluate(({ sessionId, readySelector }) => new Promise<{ contentMs: number; visibleMs: number }>((resolve, reject) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="session-row-${sessionId}"]`)
    if (!row) { reject(new Error(`Missing session ${sessionId}`)); return }
    const start = performance.now()
    let contentMs: number | null = null
    let painted = false
    const transcriptsReady = (pane: HTMLElement) => [...pane.querySelectorAll<HTMLElement>('[data-testid="conversation-scroll"]')]
      .every((viewport) => {
        const bounds = viewport.getBoundingClientRect()
        return [...viewport.querySelectorAll<HTMLElement>("[data-index]")].some((row) => {
          const rect = row.getBoundingClientRect()
          return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
        })
      })
    const contentReady = (pane: HTMLElement) => {
      const ready = pane.querySelector(readySelector)
      return ready !== null && pane.getClientRects().length > 0 &&
        (!ready.matches("[data-index]") || transcriptsReady(pane))
    }
    const sample = () => {
      if (performance.now() - start > 5000) { reject(new Error(`Session ${sessionId} was not ready within 5 seconds`)); return }
      const pane = document.querySelector<HTMLElement>(`[data-session="${sessionId}"]`)
      if (!pane || !contentReady(pane)) { requestAnimationFrame(sample); return }
      contentMs ??= performance.now() - start
      const visible = Number(getComputedStyle(pane).opacity) >= 0.99
      if (painted && visible) { resolve({ contentMs, visibleMs: performance.now() - start }); return }
      painted = visible
      requestAnimationFrame(sample)
    }
    row.click()
    requestAnimationFrame(sample)
  }), { sessionId, readySelector })
}

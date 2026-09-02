import type { PlanDocument } from "@jingler/core"
import { jinglerDark, lightModern, toTokens } from "@jingler/themes"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "../theme-provider.js"
import { PlanReview, type PlannotatorPlanHost } from "./plan-review.js"

const document: PlanDocument = {
  id: "plannotator:PLAN.md",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  reviewId: "review-1",
  sourceMarkdown: "# Auth plan\n\n- [ ] Implement auth\n",
  status: "proposed",
  plan: {
    title: "Auth plan",
    sections: [],
    stages: [],
    annotations: []
  },
  updatedAt: "2026-08-27T00:00:00.000Z",
  updatedBy: "agent"
}

const openPlannotator = vi.fn<PlannotatorPlanHost["openPlannotator"]>(async () => {})
const hidePlannotator = vi.fn()
let decisionListener: Parameters<PlannotatorPlanHost["onPlannotatorDecision"]>[0] | undefined
const host: PlannotatorPlanHost = {
  openPlannotator,
  hidePlannotator,
  onPlannotatorDecision: (listener) => {
    decisionListener = listener
    return () => { decisionListener = undefined }
  }
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  decisionListener = undefined
  vi.unstubAllGlobals()
})

describe("PlanReview", () => {
  it("opens the embedded Plannotator view with the canonical projection", async () => {
    render(
      <ThemeProvider tokens={toTokens(jinglerDark)}>
        <PlanReview document={document} host={host} />
      </ThemeProvider>
    )

    expect(screen.getByTestId("plannotator-embedded-view")).toBeTruthy()
    await waitFor(() => expect(openPlannotator).toHaveBeenCalled())
    expect(openPlannotator).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      chatId: "chat-1",
      document,
      canDecide: true,
      themeCss: expect.stringContaining("--background: var(--sb-editor)")
    }))
  })

  it("resends the embedded stylesheet when Jingler's theme changes", async () => {
    const view = render(
      <ThemeProvider tokens={toTokens(jinglerDark)}>
        <PlanReview document={document} host={host} />
      </ThemeProvider>
    )
    await waitFor(() => expect(openPlannotator).toHaveBeenCalled())
    const darkCss = openPlannotator.mock.calls.at(-1)?.[0].themeCss

    view.rerender(
      <ThemeProvider tokens={toTokens(lightModern)}>
        <PlanReview document={document} host={host} />
      </ThemeProvider>
    )
    await waitFor(() => expect(openPlannotator.mock.calls.at(-1)?.[0].themeCss).not.toBe(darkCss))
    expect(openPlannotator.mock.calls.at(-1)?.[0].themeCss).toContain("color-scheme: light")
  })

  it("routes only the current review decision", async () => {
    const onApprove = vi.fn()
    const onRevise = vi.fn()
    render(
      <ThemeProvider tokens={toTokens(jinglerDark)}>
        <PlanReview
          document={document}
          host={host}
          onApprove={onApprove}
          onRevise={onRevise}
        />
      </ThemeProvider>
    )
    await waitFor(() => expect(decisionListener).toBeDefined())

    expect(await decisionListener?.({
      sessionId: "session-1",
      chatId: "chat-1",
      reviewId: "stale",
      approved: true,
      deliveryId: "delivery-stale"
    })).toBeUndefined()
    expect(await decisionListener?.({
      sessionId: "session-1",
      chatId: "chat-1",
      reviewId: "review-1",
      approved: false,
      feedback: "Keep token compatibility",
      deliveryId: "delivery-current"
    })).toBe(true)

    expect(onApprove).not.toHaveBeenCalled()
    expect(onRevise).toHaveBeenCalledWith("Keep token compatibility")
  })

  it("hides the native view when the placeholder unmounts", async () => {
    const view = render(
      <ThemeProvider tokens={toTokens(jinglerDark)}>
        <PlanReview document={document} host={host} />
      </ThemeProvider>
    )
    await waitFor(() => expect(openPlannotator).toHaveBeenCalled())
    view.unmount()
    expect(hidePlannotator).toHaveBeenCalledWith({ sessionId: "session-1", chatId: "chat-1" })
  })
})

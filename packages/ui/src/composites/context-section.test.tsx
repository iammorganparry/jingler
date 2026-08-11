import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ContextConfig } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsView } from "./settings-view.js"

afterEach(cleanup)

const GITHUB_DISCONNECTED = {
  mode: "disconnected" as const,
  enabled: true,
  connected: false,
  user: null,
  installations: [],
  lastRefreshedAt: null,
  error: null
}

const open = (
  props: {
    context?: ContextConfig | null
    onSaveContext?: (config: ContextConfig) => void
    contextSessions?: React.ComponentProps<typeof SettingsView>["contextSessions"]
  } = {}
) => {
  render(
    <SettingsView
      githubConnection={GITHUB_DISCONNECTED}
      context={props.context ?? null}
      onSaveContext={props.onSaveContext}
      contextSessions={props.contextSessions}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: /Context/ }))
}

describe("Settings → Context", () => {
  it("ships with auto-compaction on and the maximum quality-band budget", () => {
    open()

    expect(screen.getByLabelText("Working-set budget")).toHaveProperty(
      "value",
      "500000"
    )
    expect(screen.getByText("500k tokens")).toBeDefined()
  })

  it("saves a new budget as the slider moves", () => {
    const onSaveContext = vi.fn()
    open({ onSaveContext })

    fireEvent.change(screen.getByLabelText("Working-set budget"), {
      target: { value: "360000" }
    })

    expect(onSaveContext).toHaveBeenCalledWith({
      auto: true,
      budgetTokens: 360_000
    })
  })

  it("saves the master switch", () => {
    const onSaveContext = vi.fn()
    open({ onSaveContext })

    fireEvent.click(screen.getByRole("switch"))

    expect(onSaveContext).toHaveBeenCalledWith({
      auto: false,
      budgetTokens: 500_000
    })
  })

  it("constrains the budget to the usable quality band", () => {
    open()

    const slider = screen.getByLabelText("Working-set budget")
    expect(slider).toHaveProperty("min", "256000")
    expect(slider).toHaveProperty("max", "500000")
  })

  it("reassures that the transcript is never truncated", () => {
    open()

    expect(screen.getByText(/transcript is never truncated/)).toBeDefined()
  })

  it("lists live sessions against the budget", () => {
    open({
      contextSessions: [
        {
          id: "s1",
          title: "Rate limiting",
          snapshot: {
            sessionId: "s1",
            tokens: 150_000,
            window: 200_000,
            budget: 300_000,
            triggerAt: 170_000,
            phase: "idle",
            preparing: false,
            digestReady: false,
            lastCompactedAt: null,
            compactions: 0,
            stalled: false
          }
        }
      ]
    })

    expect(screen.getByText("Rate limiting")).toBeDefined()
    expect(screen.getByText("150k")).toBeDefined()
  })
})

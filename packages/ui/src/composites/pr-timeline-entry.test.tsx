import { cleanup, render, screen } from "@testing-library/react"
import type { PrTimelineItem } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import { PrTimelineEntry } from "./pr-timeline-entry.js"

const item = (kind: PrTimelineItem["kind"]): PrTimelineItem => ({
  id: kind, author: "dan", kind, body: "Looks fine.", createdAt: "2026-07-11T09:00:00.000Z", path: null, line: null
})

afterEach(cleanup)

describe("PrTimelineEntry", () => {
  it.each([
    ["commented", "commented"],
    ["approved", "approved"],
    ["changes_requested", "requested changes"]
  ] as const)("labels %s and uses no kind-coded colour", (kind, label) => {
    const { container } = render(<PrTimelineEntry item={item(kind)} />)
    expect(screen.getByText(label)).toBeTruthy()
    expect(container.innerHTML).not.toMatch(/text-(blue|green|red)|bg-(blue|green|red)/)
  })
})

import type { Locator } from "@playwright/test"
import { expect } from "./fixtures.js"

export const PIERRE_HOST_CLASS = /jingler-pierre-host/

/** Locate Pierre's actual vertical scroll owner without depending on shadow internals. */
export const verticalScrollOwner = async (host: Locator): Promise<Locator> => {
  const elements = host.locator("*")
  const index = await elements.evaluateAll((candidates) => {
    let bestIndex = -1
    let bestRange = 0
    for (const [candidateIndex, element] of candidates.entries()) {
      const range = element.scrollHeight - element.clientHeight
      const overflowY = getComputedStyle(element).overflowY
      if (range > bestRange && (overflowY === "auto" || overflowY === "scroll")) {
        bestIndex = candidateIndex
        bestRange = range
      }
    }
    return bestIndex
  })
  expect(index).toBeGreaterThanOrEqual(0)
  return elements.nth(index)
}

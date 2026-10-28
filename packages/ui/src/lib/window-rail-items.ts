export interface RailItem { id: string; label: string; [key: string]: unknown }
export interface RailGapMarker { __gap: true; hiddenCount: number; firstHiddenId: string }
export type WindowedRailItem<T extends RailItem> = T | RailGapMarker

export function isGapMarker(item: WindowedRailItem<RailItem>): item is RailGapMarker {
  return "__gap" in item && item.__gap === true
}

/**
 * Window a long rail to first N + last N items with gap markers for hidden ranges.
 * Active item is always visible (with ±1 neighbors if it falls in a hidden range).
 */
export function windowRailItems<T extends RailItem>(
  items: ReadonlyArray<T>,
  activeId: string | undefined,
  expanded: boolean,
  maxItems = 10
): ReadonlyArray<WindowedRailItem<T>> {
  if (items.length <= maxItems || expanded) return items

  const half = Math.floor(maxItems / 2)
  const headCount = half
  const tailCount = maxItems - half

  const activeIndex = activeId ? items.findIndex(it => it.id === activeId) : -1
  const activeInHiddenRange = activeIndex >= headCount && activeIndex < items.length - tailCount

  if (!activeInHiddenRange) {
    // Simple case: first headCount + gap + last tailCount
    const head = items.slice(0, headCount)
    const tail = items.slice(-tailCount)
    const hiddenCount = items.length - maxItems
    return [
      ...head,
      { __gap: true, hiddenCount, firstHiddenId: items[headCount]!.id } as RailGapMarker,
      ...tail
    ]
  }

  // Active is in the hidden range: show it with ±1 neighbors between two gaps
  const contextStart = Math.max(headCount, activeIndex - 1)
  const contextEnd = Math.min(items.length - tailCount, activeIndex + 2) // +2 because slice is exclusive
  const head = items.slice(0, headCount)
  const context = items.slice(contextStart, contextEnd)
  const tail = items.slice(-tailCount)

  const gap1Count = contextStart - headCount
  const gap2Count = items.length - tailCount - contextEnd

  const result: WindowedRailItem<T>[] = [...head]
  if (gap1Count > 0) {
    result.push({ __gap: true, hiddenCount: gap1Count, firstHiddenId: items[headCount]!.id } as RailGapMarker)
  }
  result.push(...context)
  if (gap2Count > 0) {
    result.push({ __gap: true, hiddenCount: gap2Count, firstHiddenId: items[contextEnd]!.id } as RailGapMarker)
  }
  result.push(...tail)

  return result
}

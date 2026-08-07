export const PLAN_SPLIT_MIN_WIDTH = 360
export const PLAN_SPLIT_HANDLE_WIDTH = 1
/** Plan Review owns two thirds of a new split; chat keeps the remaining third. */
export const DEFAULT_PLAN_SPLIT_RATIO = 2 / 3

const availableColumnWidth = (width: number): number =>
  Math.max(0, width - PLAN_SPLIT_HANDLE_WIDTH)

export const clampedPlanSplitRatio = (ratio: number, width: number): number => {
  const available = availableColumnWidth(width)
  if (available <= PLAN_SPLIT_MIN_WIDTH * 2) return 0.5
  const minimum = PLAN_SPLIT_MIN_WIDTH / available
  return Math.max(minimum, Math.min(1 - minimum, ratio))
}

export const resizedPlanSplitRatio = (
  ratio: number,
  width: number,
  deltaX: number
): number =>
  width <= 0
    ? ratio
    : clampedPlanSplitRatio(
        ratio - deltaX / availableColumnWidth(width),
        width
      )

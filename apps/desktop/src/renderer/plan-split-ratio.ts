export const PLAN_SPLIT_MIN_WIDTH = 360

export const clampedPlanSplitRatio = (ratio: number, width: number): number => {
  if (width <= PLAN_SPLIT_MIN_WIDTH * 2) return 0.5
  const minimum = PLAN_SPLIT_MIN_WIDTH / width
  return Math.max(minimum, Math.min(1 - minimum, ratio))
}

export const resizedPlanSplitRatio = (
  ratio: number,
  width: number,
  deltaX: number
): number =>
  width <= 0
    ? ratio
    : clampedPlanSplitRatio(ratio - deltaX / width, width)

export const SESSION_BROWSER_SPLIT_BREAKPOINT = 960
export const SESSION_BROWSER_MIN_CHAT_WIDTH = 320
export const SESSION_BROWSER_MIN_BROWSER_WIDTH = 480
export const SESSION_BROWSER_SPLIT_HANDLE_WIDTH = 1
export const DEFAULT_SESSION_BROWSER_RATIO = 2 / 3

const availableWidth = (width: number): number =>
  Math.max(0, width - SESSION_BROWSER_SPLIT_HANDLE_WIDTH)

/** Browser owns `ratio` of the row; chat owns the remainder. */
export const clampedSessionBrowserRatio = (ratio: number, width: number): number => {
  const available = availableWidth(width)
  if (available <= 0) return DEFAULT_SESSION_BROWSER_RATIO

  const browserMinimum = SESSION_BROWSER_MIN_BROWSER_WIDTH / available
  const browserMaximum = 1 - SESSION_BROWSER_MIN_CHAT_WIDTH / available
  if (browserMinimum >= browserMaximum) return DEFAULT_SESSION_BROWSER_RATIO

  return Math.max(browserMinimum, Math.min(browserMaximum, ratio))
}

/** Moving the divider right gives chat more room and Browser less. */
export const resizedSessionBrowserRatio = (
  ratio: number,
  width: number,
  deltaX: number
): number =>
  width <= 0
    ? ratio
    : clampedSessionBrowserRatio(
        ratio - deltaX / availableWidth(width),
        width
      )

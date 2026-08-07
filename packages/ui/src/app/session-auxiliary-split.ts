export const SESSION_AUXILIARY_SPLIT_BREAKPOINT = 960
export const SESSION_AUXILIARY_MIN_CHAT_WIDTH = 320
export const SESSION_AUXILIARY_MIN_VIEW_WIDTH = 480
export const SESSION_AUXILIARY_SPLIT_HANDLE_WIDTH = 1
export const DEFAULT_SESSION_AUXILIARY_RATIO = 2 / 3

const availableWidth = (width: number): number =>
  Math.max(0, width - SESSION_AUXILIARY_SPLIT_HANDLE_WIDTH)

/** The selected auxiliary view owns `ratio` of the row; chat owns the rest. */
export const clampedSessionAuxiliaryRatio = (ratio: number, width: number): number => {
  const available = availableWidth(width)
  if (available <= 0) return DEFAULT_SESSION_AUXILIARY_RATIO

  const viewMinimum = SESSION_AUXILIARY_MIN_VIEW_WIDTH / available
  const viewMaximum = 1 - SESSION_AUXILIARY_MIN_CHAT_WIDTH / available
  if (viewMinimum >= viewMaximum) return DEFAULT_SESSION_AUXILIARY_RATIO

  return Math.max(viewMinimum, Math.min(viewMaximum, ratio))
}

/** Moving the divider right gives chat more room and the selected view less. */
export const resizedSessionAuxiliaryRatio = (
  ratio: number,
  width: number,
  deltaX: number
): number =>
  width <= 0
    ? ratio
    : clampedSessionAuxiliaryRatio(
        ratio - deltaX / availableWidth(width),
        width
      )

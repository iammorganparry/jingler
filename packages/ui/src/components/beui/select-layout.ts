/** Keep all corners and margins explicit when a select flips placement. */
export function selectEdgeValues<Gap, Radius>(
  isTop: boolean,
  nearGap: Gap,
  farGap: Gap,
  nearRadius: Radius,
  farRadius: Radius
) {
  const topRadius = isTop ? farRadius : nearRadius
  const bottomRadius = isTop ? nearRadius : farRadius
  return {
    marginTop: isTop ? farGap : nearGap,
    marginBottom: isTop ? nearGap : farGap,
    borderTopLeftRadius: topRadius,
    borderTopRightRadius: topRadius,
    borderBottomLeftRadius: bottomRadius,
    borderBottomRightRadius: bottomRadius
  }
}

/** Home/End use bounds; arrow navigation wraps in the currently enabled options. */
export function selectOptionIndex(key: string, current: number, length: number): number {
  if (key === "Home") return 0
  if (key === "End") return length - 1
  return (current + (key === "ArrowDown" ? 1 : -1) + length) % length
}

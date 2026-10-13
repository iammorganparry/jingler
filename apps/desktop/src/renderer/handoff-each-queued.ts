/**
 * Runs `handoffOne` for every id, then reports once all of them have landed.
 * `onAllHandedOff` never fires if any hand-off fails, so a partial batch stays silent
 * rather than claiming success.
 */
export const handoffEachQueued = (
  ids: ReadonlyArray<string>,
  handoffOne: (id: string, onHandedOff: () => void) => void,
  onAllHandedOff: (count: number) => void
): void => {
  let remaining = ids.length
  for (const id of ids) {
    handoffOne(id, () => {
      remaining -= 1
      if (remaining === 0) onAllHandedOff(ids.length)
    })
  }
}

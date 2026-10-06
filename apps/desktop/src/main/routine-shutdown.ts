/** Bound the application's wait, without asserting that unresolved mutation work stopped. */
export const stopRoutinesBeforeQuit = (stop: () => Promise<unknown>, finish: () => void, unresolved: () => void, failed: (error: unknown) => void): void => {
  let finished = false
  const complete = () => { if (!finished) { finished = true; finish() } }
  const deadline = setTimeout(() => { unresolved(); complete() }, 15_000)
  void Promise.resolve().then(stop).catch(failed).finally(() => { clearTimeout(deadline); complete() })
}

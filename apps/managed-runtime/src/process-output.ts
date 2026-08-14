/** Returns output retained by the sandbox after the streamed prefix. */
export const unstreamedProcessOutput = (
  streamed: string,
  retained: string,
): string => {
  if (!retained.startsWith(streamed)) {
    throw new Error("Managed process output diverged from retained logs")
  }
  return retained.slice(streamed.length)
}

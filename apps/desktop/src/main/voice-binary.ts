/** First existing path wins: user-configured, then bundled with the app, then the dev lookup. */
export const pickWhisperBinary = (
  candidates: ReadonlyArray<string | undefined>,
  exists: (path: string) => boolean
): string | null => candidates.find((path): path is string => path !== undefined && exists(path)) ?? null

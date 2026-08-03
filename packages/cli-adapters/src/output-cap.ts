/**
 * Capping a tool's output, shared by every harness adapter.
 *
 * A tool's output rides the RPC to the renderer AND is persisted into the
 * session's transcript.json, so an uncapped `pnpm test` log would bloat the file
 * that every future read pays for. Live `ToolDelta` snapshots are capped the same
 * way, since a running command's aggregated output grows without bound.
 */
export const OUTPUT_CAP = 6_000
/** Kept from the front when capping — enough to see what the command started doing. */
export const OUTPUT_HEAD = 3_600
/** Kept from the end when capping — enough to retain a test or build summary. */
export const OUTPUT_TAIL = OUTPUT_CAP - OUTPUT_HEAD

/** Format retained output consistently for whole strings and incremental streams. */
export const formatCappedOutput = (head: string, tail: string, dropped: number): string =>
  `${head}\n\n… ${dropped.toLocaleString()} characters omitted …\n\n${tail}`

/**
 * Cap a tool's output, keeping BOTH ends.
 *
 * Which end matters depends on the command: a compile error lists its first
 * failures at the top, while a test run puts the summary that explains it at the
 * very bottom. Keeping only one end reliably hides the answer for half of them,
 * so we keep the head and the tail and say what went missing — a silent cut
 * reads as "that's all it printed".
 */
export const capOutput = (text: string): string => {
  if (text.length <= OUTPUT_CAP) return text
  const head = text.slice(0, OUTPUT_HEAD)
  const tail = text.slice(text.length - OUTPUT_TAIL)
  return formatCappedOutput(head, tail, text.length - OUTPUT_HEAD - OUTPUT_TAIL)
}

/**
 * An append-only accumulator whose `snapshot()` equals `capOutput` of every
 * chunk `append`ed so far — while retaining only the head, the tail, and a
 * running length, never the full text between them.
 *
 * Codex streams a command's stdout+stderr as many `outputDelta` notifications,
 * each appended to that tool's running output. Retaining the raw concatenation
 * let a command that printed hundreds of MB (e.g. `rg` over large transcript
 * files) grow one string without bound until Electron's V8 heap OOM'd. This
 * keeps the retained size at O(OUTPUT_CAP) no matter how much a command prints.
 */
export interface CappedAccumulator {
  readonly append: (text: string) => void
  readonly snapshot: () => string
}

export const makeCappedAccumulator = (): CappedAccumulator => {
  let chars = 0
  let head = ""
  let tail = ""
  const append = (text: string): void => {
    if (text.length === 0) return
    chars += text.length
    if (head.length < OUTPUT_HEAD) head += text.slice(0, OUTPUT_HEAD - head.length)
    // When the chunk alone fills the tail window it displaces the previous tail
    // entirely, so slice the chunk directly — never materialize a full-size
    // transient string just to drop most of it.
    tail = (text.length >= OUTPUT_TAIL ? text : `${tail}${text}`).slice(-OUTPUT_TAIL)
  }
  const snapshot = (): string => {
    if (chars <= OUTPUT_CAP) {
      // Below the cap, head and tail overlap; drop the overlap to rebuild the
      // exact text without retaining a third copy.
      const overlap = Math.max(0, head.length + tail.length - chars)
      return `${head}${tail.slice(overlap)}`
    }
    return formatCappedOutput(head, tail, chars - head.length - tail.length)
  }
  return { append, snapshot }
}

/**
 * The single canonical string comparator for every reproducible ordering in the
 * memory system. It is a plain code-unit comparison (NOT locale-aware): stable,
 * deterministic, and byte-for-byte identical across runtimes, which is what the
 * reproducible graph/index/manifest hashes depend on. Every package and the worker
 * import THIS rather than re-declaring it, so the ordering can never silently drift
 * between the scorer, the durable object, and the exported artifacts.
 */
export const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { resolveOpenablePath } from "./path-detect.js"

/**
 * How a path buried anywhere in the transcript reaches the session's Files tab.
 *
 * A context rather than a prop, because the callers are leaves — an inline code
 * span inside Streamdown's own render tree, a tool-call header six components
 * down — and threading `onOpenPath` to them would mean adding a prop to every
 * component in between, most of which have no business knowing about assets.
 *
 * Absence is a supported state, not a bug: Storybook and the component tests
 * mount no provider, and there the same components must render exactly as they
 * did before this feature existed — plain, inert text. Every consumer below
 * returns null rather than throwing when the context is missing.
 */
export interface OpenAssetContextValue {
  /** Open a worktree-relative (or worktree-absolute) path in Files. */
  open: (path: string) => void
  /**
   * Every tracked file in the session's worktree.
   *
   * This is the gate that keeps `v1.2.3` and `npm.install` from becoming links.
   * An empty set is therefore a real answer — "nothing is openable" — and NOT a
   * reason to fall back to matching on shape alone.
   */
  knownFiles: ReadonlySet<string>
  /**
   * The session's worktree root, absolute. Optional: Storybook and the tests
   * mount none, and there an absolute path is still matched by suffix. When it
   * IS present, an absolute path OUTSIDE the root is refused — so an agent citing
   * `/usr/lib/node_modules/x/package.json` can't open this worktree's own
   * `package.json` by accident.
   */
  worktreeRoot?: string
}

const OpenAssetContext = createContext<OpenAssetContextValue | null>(null)

export function OpenAssetProvider({
  open,
  knownFiles,
  worktreeRoot,
  children
}: OpenAssetContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ open, knownFiles, worktreeRoot }),
    [open, knownFiles, worktreeRoot]
  )
  return <OpenAssetContext.Provider value={value}>{children}</OpenAssetContext.Provider>
}

/** The asset-opening context, or null outside a provider. */
export const useOpenAsset = (): OpenAssetContextValue | null => useContext(OpenAssetContext)

/**
 * A click handler for `raw` if it names a file we can show, else null.
 *
 * Returning null (rather than a no-op handler) is deliberate: the caller uses it
 * to decide whether to render a BUTTON at all, so a path we can't open stays
 * ordinary text with no hover state promising something that won't happen.
 */
export const useOpenPath = (raw: string | null | undefined): (() => void) | null => {
  const ctx = useOpenAsset()
  return useMemo(() => {
    if (!ctx || !raw) return null
    const path = resolveOpenablePath(raw, ctx.knownFiles, ctx.worktreeRoot)
    return path === null ? null : () => ctx.open(path)
  }, [ctx, raw])
}

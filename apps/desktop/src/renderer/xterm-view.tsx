/**
 * XtermView — one live xterm.js cell bound to one PTY (by `terminalId`).
 *
 * Performance choices:
 *  - **WebGL renderer** (GPU) while `active`, DOM fallback otherwise — hidden
 *    tabs release their GPU context instead of pinning one apiece.
 *  - **Bounded scrollback** (5000 lines) caps renderer memory.
 *  - Output arrives already *coalesced* from the main process, so `term.write`
 *    is called at most ~60×/sec/terminal regardless of raw throughput.
 *  - Resize is rAF-debounced to avoid reflow thrash while dragging the splitter.
 *
 * Lifecycle: everything (xterm instance, WebGL context, attach stream, input
 * subscription, ResizeObserver) is torn down on unmount — no leaks. Detaching
 * does NOT kill the PTY; it keeps running in main and is re-attachable.
 */
import { useEffect, useRef, useState } from "react"
import { useThemeTokens } from "@jingler/ui"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { rpc } from "./rpc-client.js"
import { mirrorWrite } from "./agent-command-tabs.js"

/**
 * The terminal is themed like everything else, but through a different pipe:
 * xterm paints to a canvas and takes a JS object, so it reads `ThemeTokens`
 * directly instead of CSS custom properties. `tokens.terminal` is the theme's
 * own `terminal.ansi*` palette where it declares one, and a derivation from the
 * accent ramp where it does not — see `@jingler/themes`'s mapper.
 */

export interface XtermViewProps {
  terminalId: string
  /**
   * Whether this cell is the one the operator can currently see. Hidden cells
   * stay fully mounted (scrollback, PTY attachment, DOM) but release their
   * WebGL context — each context holds a GPU allocation and browsers cap the
   * number of live ones, so N open tabs must not pin N contexts for the whole
   * session. Defaults to true for callers without a tab strip.
   */
  active?: boolean
  /** Called with the exit code when the shell process ends. */
  onExit?: (code: number) => void
  /**
   * Read-only mode: render an agent command's cumulative output snapshot
   * instead of attaching to a PTY. No input, no resize RPC.
   */
  mirror?: { readonly output: string | undefined; readonly status: "running" | "success" | "error" | null }
}

export function XtermView({ terminalId, active = true, onExit, mirror }: XtermViewProps) {
  const isMirror = mirror !== undefined
  const containerRef = useRef<HTMLDivElement>(null)
  // Keep the latest onExit without re-running the (expensive) mount effect.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  const { terminal: palette } = useThemeTokens()
  /**
   * The palette is read through a ref in the mount effect, and applied through
   * a SEPARATE effect afterwards.
   *
   * Putting it in the mount effect's dependency array would tear down and
   * rebuild the whole terminal on every theme switch — losing the WebGL
   * context, the PTY attachment and, most visibly, the entire scrollback. A
   * colour change must not cost the operator their session output.
   */
  const themeRef = useRef(palette)
  themeRef.current = palette
  // State, not a ref: the WebGL and theme effects below must re-run when the
  // mount effect rebuilds the Terminal, and a ref mutation cannot tell them.
  const [term, setTerm] = useState<Terminal | null>(null)
  // What a mirror has already written to the current Terminal instance.
  const shownRef = useRef("")

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      scrollback: 5000,
      // Must lead with the `Variable` name — that is what Fontsource registers
      // the bundled woff2 under, and xterm takes a raw string rather than
      // reading `--font-mono`, so it cannot inherit the fix from globals.css.
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: !isMirror,
      disableStdin: isMirror,
      allowProposedApi: true,
      theme: { ...themeRef.current }
    })

    shownRef.current = ""
    setTerm(term)

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => void window.jingler.openExternal(uri)))
    term.open(el)

    fit.fit()

    // Operator input → PTY. A mirror has no PTY; its output arrives via the `mirror` effect.
    const inputSub = isMirror ? null : term.onData((data) => void rpc.terminalWrite(terminalId, data))

    // PTY output → terminal. Replays scrollback first, then live coalesced frames.
    const detach = isMirror ? () => {} : rpc.terminalAttach(terminalId, (chunk) => {
      if (chunk._tag === "data") {
        term.write(chunk.data)
      } else {
        term.write(`\r\n\x1b[2m[process exited with code ${chunk.exitCode}]\x1b[0m\r\n`)
        onExitRef.current?.(chunk.exitCode)
      }
    })

    // Fit + inform the PTY on resize, rAF-debounced (splitter drags fire fast).
    let raf = 0
    const scheduleFit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* container detached mid-drag */
        }
        if (!isMirror) void rpc.terminalResize(terminalId, term.cols, term.rows)
      })
    }
    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(el)

    // Push the initial size to the PTY (create used a guessed 80×24).
    if (!isMirror) {
      void rpc.terminalResize(terminalId, term.cols, term.rows)
      term.focus()
    }

    return () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      inputSub?.dispose()
      detach()
      term.dispose()
      setTerm(null)
    }
  }, [terminalId, isMirror])

  // Mirror output: append only what's new; redraw when the snapshot was trimmed or replaced.
  const mirrorOutput = mirror?.output
  const mirrorStatus = mirror?.status
  useEffect(() => {
    if (term === null || !isMirror) return
    const update = mirrorWrite(shownRef.current, mirrorOutput?.replace(/\r?\n/g, "\r\n"), mirrorStatus === "running")
    if (update === null) return
    if (update.reset) term.reset()
    if (update.data) term.write(update.data)
    shownRef.current = update.reset ? update.data : shownRef.current + update.data
  }, [isMirror, mirrorOutput, mirrorStatus, term])
  useEffect(() => {
    if (term === null || mirrorStatus == null || mirrorStatus === "running") return
    term.write(`\r\n\x1b[2m[agent command ${mirrorStatus === "success" ? "finished" : "failed"}]\x1b[0m\r\n`)
  }, [mirrorStatus, term])

  // GPU rendering only while visible; hidden cells drop back to the DOM
  // renderer (they are not painting anyway) so their context is released.
  // `term` in the deps re-attaches the addon when a remount rebuilds the
  // Terminal instance.
  useEffect(() => {
    if (term === null || !active) return
    // Context creation can fail (headless, exhausted contexts) — silently keep
    // the DOM renderer, exactly as the old mount-time path did.
    let addon: WebglAddon | null = null
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
      addon = webgl
    } catch {
      addon = null
    }
    return () => addon?.dispose()
  }, [active, term])

  // Repaint an already-running terminal in place: no remount, no lost
  // scrollback, no dropped PTY.
  useEffect(() => {
    if (term !== null) term.options.theme = { ...palette }
  }, [palette, term])

  return <div ref={containerRef} className="h-full w-full" />
}

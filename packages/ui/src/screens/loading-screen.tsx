import { useEffect, useRef, useState } from "react"
import { BRAND_SHADER_BACKGROUND, BrandShader } from "../brand/brand-shader.js"
import { useOptionalThemeTokens } from "../theme-provider.js"

/**
 * Full-bleed launch splash, shown while the app boots and while auth resolves
 * (see `appMachine`'s loading/starting states and the `checking` branch in
 * App.tsx).
 *
 * The whole screen is the brand mark, run through a Paper Design shader —
 * see `../brand/brand-shader.tsx` for the two prop sets and the two ways it
 * refuses to animate. Everything else here is quiet by design: a status line, a
 * progress bar and the wordmark. The shader is the thing worth looking at, and a
 * splash that competes with itself just reads as busy.
 *
 * ## Why the progress bar is a lie, carefully
 *
 * Nothing here knows how far along the boot is. Main resolves the config, the
 * theme, the session store and the plugin host on its own clock, and the
 * renderer is not told about any of it — it is told when the machine leaves
 * `loading`, and that is all.
 *
 * So the bar eases toward 90% and STOPS. It never completes on its own, because
 * a bar that fills and then sits there is a bar that says "finished" while the
 * app is still working, which is worse than no bar. The unmount is the
 * completion. The easing is asymptotic for the same reason: a slow boot should
 * keep showing movement without ever implying it is nearly done.
 *
 * Honours `prefers-reduced-motion` — the bar holds at a static value and
 * `BrandShader` swaps itself for the still mark.
 */

/** Status copy, in the order it appears. Cosmetic — nothing observes the boot. */
const PHASES = ["Waking up", "Loading workspace", "Spinning up agents"] as const

/** How long the bar takes to ease from 0 to its ceiling, in ms. */
const RAMP_MS = 6000
/** The ceiling. Never 100 — see the note above. */
const CEILING = 90

export function LoadingScreen() {
  const bar = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState(0)
  const [reduced, setReduced] = useState(false)

  // Resolved here rather than left to `BrandShader` because the PAGE has to be
  // painted the same colour as the tile, and both have to agree on which ground
  // that is. High contrast normalises to dark, matching the shader.
  const tokens = useOptionalThemeTokens()
  const ground = tokens?.kind === "light" ? "light" : "dark"

  useEffect(() => {
    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    setReduced(still)

    if (still) {
      if (bar.current) bar.current.style.width = "40%"
      return
    }

    let raf = 0
    const start = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / RAMP_MS)
      // Ease-out cubic: most of the travel happens early, so a fast boot looks
      // fast and a slow one still creeps rather than freezing.
      const eased = 1 - (1 - p) ** 3
      if (bar.current) bar.current.style.width = `${(eased * CEILING).toFixed(1)}%`
      setPhase(p < 0.3 ? 0 : p < 0.7 ? 1 : 2)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      data-testid="loading-screen"
      className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden font-sans"
      style={{ background: BRAND_SHADER_BACKGROUND[ground] }}
    >
      {/*
        The shader owns the WHOLE window, and the page behind it is painted the
        shader's own `colorBack`.

        Both halves are needed. Painting the page `--sb-canvas` left the mark on
        a visibly different plate; matching the colour exactly still left a
        rectangle, because the shader lays grain across its square and that
        lifts it a few levels above a flat fill. Only letting it fill the
        surface removes the edge instead of disguising it — the page colour then
        matters solely for the frame before WebGL has drawn anything.

        `fit: "contain"` keeps the MARK centred and unstretched at any window
        shape; only the field around it grows.
      */}
      <div className="absolute inset-0">
        <BrandShader fill ground={ground} />
      </div>

      {/*
        Pinned to the lower third rather than flowed under the mark. The shader
        is out of flow now, so a flowed block would centre itself in the window
        and land on top of the mark's brightest area.
      */}
      <div className="absolute bottom-[14%] flex w-[300px] flex-col items-center gap-3 text-text-body">
        <span className="text-[13px] font-medium tracking-[-0.1px] text-text-body">
          {reduced ? "Loading" : PHASES[phase]}
        </span>

        {/*
          The track is a wash of the ground rather than `bg-surface`: the page is
          the shader's `colorBack`, not a theme surface, so a `--sb-surface`
          track reads as a grey bar that belongs to a different screen.
        */}
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-current/15">
          <div
            ref={bar}
            className="h-full w-0 rounded-full transition-[width] duration-150 ease-out"
            style={{
              background: "linear-gradient(90deg,var(--sb-brand),var(--sb-brand-hover))"
            }}
          />
        </div>
      </div>
    </div>
  )
}

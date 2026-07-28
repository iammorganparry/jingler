import { useEffect, useState } from "react"
import { BRAND_SHADER_BACKGROUND, BrandShader, brandCanAnimate } from "../brand/brand-shader.js"
import { useOptionalThemeTokens } from "../theme-provider.js"

/**
 * Full-bleed launch splash, shown while the app boots and while auth resolves
 * (see `appMachine`'s loading/starting states and the `checking` branch in
 * App.tsx).
 *
 * The whole screen is the brand mark, run through a Paper Design shader — see
 * `../brand/brand-shader.tsx` for the two prop sets and the ways it refuses to
 * animate. That is the entire screen. There is nothing else on it.
 *
 * ## What used to be here, and why it went
 *
 * A progress bar and a cycling status line ("Waking up", "Loading workspace").
 * Both were fiction. Nothing in the renderer knows how far along the boot is —
 * main resolves the config, the theme, the session store and the plugin host on
 * its own clock and reports none of it, so the bar eased toward 90% and stopped,
 * and the status line was three strings on a timer that described no observed
 * state.
 *
 * Neither was load-bearing and both drew the eye away from the one honest thing
 * on the screen. The mark animating IS the progress indication: it says the app
 * is alive without claiming to know how much is left. See `useSplashHold` for
 * the other half of that — an animation nobody sees indicates nothing at all.
 *
 * `BrandShader` handles `prefers-reduced-motion` and a missing WebGL context by
 * swapping itself for the still mark, so there is no motion decision to make
 * here any more.
 */

/**
 * How long the splash stays up, at minimum, measured from app start.
 *
 * The shader loops rather than ending, so "until the animation finishes" has to
 * mean "long enough to read as one deliberate beat" — this is that number. Below
 * about two seconds the mark is a flicker on a fast boot, which is worse than no
 * animation: it reads as a glitch rather than as branding.
 */
export const SPLASH_HOLD_MS = 2400

/**
 * When the renderer started, as close as this module can get to it — module
 * evaluation happens before React mounts.
 *
 * The floor is measured from HERE and not from the splash's mount, which is what
 * keeps it nearly free: the hold is `max(0, SPLASH_HOLD_MS - however long boot
 * already took)`. A slow boot pays nothing, and only a boot that beats the
 * animation waits at all.
 */
const bootAt = typeof performance === "object" ? performance.now() : 0

const holdRemaining = (): number =>
  typeof performance === "object" ? Math.max(0, SPLASH_HOLD_MS - (performance.now() - bootAt)) : 0

/**
 * Whether the splash should stay up even though whatever it was waiting for is
 * ready.
 *
 * Callers OR this into their own loading condition. It exists because boot is
 * often faster than the thing it shows: the mark would appear and vanish inside
 * a couple of frames, and an operator would see a flash of red where a logo
 * should have been. Holding the screen open costs a boot that was already
 * imperceptible and buys the one moment the app has to look like itself.
 *
 * Returns false immediately — no hold at all — when the mark will not animate on
 * this machine (`prefers-reduced-motion`, or no WebGL context). There is nothing
 * to wait for then, and making someone who asked for less motion sit through a
 * still image would be the exact opposite of honouring the request. That also
 * means jsdom and headless runs are never delayed, since neither has a GL
 * context to give.
 */
export const useSplashHold = (): boolean => {
  const [held, setHeld] = useState(() => holdRemaining() > 0 && brandCanAnimate())

  useEffect(() => {
    if (!held) return
    const timer = setTimeout(() => setHeld(false), holdRemaining())
    return () => clearTimeout(timer)
  }, [held])

  return held
}

export function LoadingScreen() {
  // Resolved here rather than left to `BrandShader` because the PAGE has to be
  // painted the same colour as the tile, and both have to agree on which ground
  // that is. High contrast normalises to dark, matching the shader.
  const tokens = useOptionalThemeTokens()
  const ground = tokens?.kind === "light" ? "light" : "dark"

  return (
    <div
      data-testid="loading-screen"
      className="relative h-full w-full overflow-hidden"
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
    </div>
  )
}

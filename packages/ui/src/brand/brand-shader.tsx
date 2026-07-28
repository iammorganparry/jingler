/// <reference path="../css.d.ts" />
import { useEffect, useState } from "react"
import { Heatmap } from "@paper-design/shaders-react"
import { useOptionalThemeTokens } from "../theme-provider.js"
import { cn } from "../lib/cn.js"
import { JinglerMark } from "./jingler-mark.js"
import markSrc from "./assets/jingler-mark-shader.png"

/**
 * The animated Jingler mark — a Paper Design `Heatmap` shader run over the logo.
 *
 * ## Why the source image is BLACK
 *
 * `markSrc` is the mark filled solid black on transparent, which looks wrong
 * sitting in the assets directory and is correct. The shader treats the image
 * as a heightfield rather than as artwork: luminance drives the contour, and
 * `colors` recolours the result from scratch. Feeding it the brand-red mark
 * would double-apply the hue and wash the whole thing out.
 *
 * ## Why two prop sets and not one plus a background swap
 *
 * `colorBack` is not a backdrop the mark sits on — it is one end of the ramp
 * the shader interpolates through, so the glow, contour and noise all read
 * differently against it. The light variant therefore needs its own noise,
 * glow and contour values, not just a different backdrop; the two sets below
 * are the brand's, and are not knobs to tune ad hoc.
 *
 * The `GEOMETRY` block is shared because framing does not depend on ground.
 *
 * The light variant is MUCH fainter than the dark one — `contour: 0.2` and
 * `outerGlow: 0.05` against `#f9f6f6` give a pale blush rather than the dark
 * variant's neon. That is the brand's call, not a bug, and it is worth saying
 * out loud because the obvious "fix" (raising contour toward 1) makes the light
 * variant render BLANK: past roughly 0.6 the mark's signal folds into the
 * near-white ground entirely. If it ever needs to be louder, raise `innerGlow`
 * and leave `contour` alone.
 *
 * ## Two ways this refuses to run
 *
 * `prefers-reduced-motion` and a missing WebGL context both fall back to the
 * static mark. The second is not hypothetical: Electron falls back to SwiftShader
 * or fails outright on some Linux/VM GPU stacks, and the splash is the FIRST
 * thing an operator sees — a blank rectangle there reads as "the app is broken",
 * not "the animation is unavailable".
 *
 * ## And one frame where it renders NEITHER
 *
 * Both of those checks need the DOM, so both resolve in an effect — one frame
 * after mount. Until they do this renders an empty box of the right size, which
 * is deliberate and is not the same as defaulting to the static mark: on the
 * splash this component fills the window, so "default to static" put a
 * viewport-sized logo on screen for a frame on every launch.
 */

/**
 * The shader's own background, per ground — exported because the SPLASH has to
 * paint the same colour.
 *
 * The shader fills its square with `colorBack` and the square is smaller than
 * the window, so anything painting the page a different colour leaves the mark
 * sitting on a visible plate. Deriving the page colour from a theme token
 * instead would put two nearly-equal values next to each other, which is worse
 * than either matching or clearly differing: a 3% seam reads as a rendering
 * artefact.
 *
 * Note these are NOT `--sb-canvas`. The dark variant is true black and the
 * light one `#f9f6f6`, because those are the values the shader's glow and
 * contour were tuned against — see the prop sets below.
 */
export const BRAND_SHADER_BACKGROUND = {
  dark: "#000000",
  light: "#f9f6f6"
} as const

/** Framing. Ground-independent, so both variants share it. */
const GEOMETRY = {
  fit: "contain",
  rotation: 0,
  originX: 0.5,
  originY: 0.5,
  offsetX: 0,
  offsetY: 0,
  frame: 0,
  worldWidth: 0,
  worldHeight: 0,
  angle: 22
} as const

const DARK = {
  noise: 0.34,
  innerGlow: 1,
  outerGlow: 0.22,
  contour: 1,
  speed: 0.4,
  scale: 0.14,
  colors: ["#EF3F57", "#ffffff"],
  colorBack: BRAND_SHADER_BACKGROUND.dark
}

const LIGHT = {
  noise: 0.08,
  innerGlow: 0.55,
  outerGlow: 0.05,
  contour: 0.2,
  speed: 0.35,
  scale: 0.15,
  colors: ["#EF3F57", "#b80f26"],
  colorBack: BRAND_SHADER_BACKGROUND.light
}

/**
 * Whether the mark will actually ANIMATE on this machine, answered synchronously.
 *
 * The component asks the same two questions through hooks, because it has to
 * re-render when the answers arrive. The splash needs them before it renders at
 * all — there is no point holding a screen open to let an animation play when
 * the animation is a still image — so it gets this instead.
 */
export const brandCanAnimate = (): boolean => {
  if (typeof window === "undefined" || typeof document === "undefined") return false
  const still =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  return !still && probeWebGl()
}

/**
 * Whether the operator has asked for less motion.
 *
 * Subscribed rather than read once: the OS setting can change while the app is
 * open, and the splash can be on screen for the whole of a slow boot.
 */
const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return reduced
}

/**
 * Whether this renderer can actually give us a WebGL context.
 *
 * Probed on a throwaway canvas rather than trusting `"WebGL2RenderingContext" in
 * window`: the constructor exists on machines where context creation still fails
 * (blocklisted drivers, a headless CI display, a VM with no GPU passthrough).
 *
 * Memoised at module scope because the answer cannot change within a session and
 * the probe allocates a real GL context. `null` means "not asked yet", which
 * `useWebGl` needs to be able to distinguish — see below.
 */
let webGlSupport: boolean | null = null
export const probeWebGl = (): boolean => {
  if (webGlSupport !== null) return webGlSupport
  try {
    const probe = document.createElement("canvas")
    webGlSupport = Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"))
  } catch {
    webGlSupport = false
  }
  return webGlSupport
}

/**
 * The probe's answer, or `null` until it has one.
 *
 * THREE states, not two, and the third is the whole point. The probe has to run
 * after mount (jsdom and SSR have no canvas), so a two-state hook has to pick a
 * value for the first render — and `false` meant every mount painted the STATIC
 * fallback for a frame before swapping to the shader. At `size={320}` nobody
 * noticed. On the splash, where this fills the window, that frame is the mark at
 * 62% of the viewport: a giant logo that flashes once per launch, which is the
 * opposite of the thing the splash is for.
 *
 * `null` renders neither variant — see the component. One empty frame on the
 * shader's own ground is invisible; a full-screen logo is not.
 */
const useWebGl = (): boolean | null => {
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => {
    setOk(probeWebGl())
  }, [])
  return ok
}

export interface BrandShaderProps {
  /** Rendered size in px. Square — the shader's source image is square. */
  size?: number
  /**
   * Fill the positioned parent instead of rendering a fixed square.
   *
   * This is how the splash uses it, and the reason is the NOISE. `colorBack`
   * matching the page exactly is not enough to hide the tile's edge: the shader
   * lays grain over its whole square, which lifts it a few levels above the flat
   * page and leaves a visible rectangle. Letting the shader own the entire
   * surface removes the boundary rather than trying to disguise it.
   *
   * `fit: "contain"` still governs the MARK, so it stays centred and unstretched
   * however wide the window is — only the field around it grows.
   */
  fill?: boolean
  className?: string
  /**
   * Force a ground instead of reading the active theme. Only for Storybook and
   * tests; in the app the theme is the answer.
   */
  ground?: "dark" | "light"
}

export function BrandShader({ size = 320, fill = false, className, ground }: BrandShaderProps) {
  const tokens = useOptionalThemeTokens()
  const reduced = useReducedMotion()
  const webgl = useWebGl()

  // High contrast normalises to the dark set: its ground is black, and the
  // light variant's near-white `colorBack` would be a flashbang on it.
  const kind = ground ?? (tokens?.kind === "light" ? "light" : "dark")
  const box = fill ? { width: "100%", height: "100%" } : { width: size, height: size }

  // The probe has not answered yet. Hold the space and paint nothing rather than
  // guessing a variant — see `useWebGl`. Guessing meant the splash flashed the
  // static mark across the whole window before the shader took over.
  if (webgl === null) {
    return (
      <span className={className} style={box} data-jingler-brand="pending" aria-hidden="true" />
    )
  }

  if (reduced || !webgl) {
    // The vector mark, NOT `markSrc` — that PNG is filled black for the
    // shader's benefit and would be invisible on a dark ground. `JinglerMark`
    // paints with `currentColor`, so it lands on brand in every theme.
    return (
      <span
        className={cn("flex items-center justify-center text-brand", className)}
        style={box}
        data-jingler-brand="static"
      >
        <JinglerMark className="h-[62%] w-auto" />
      </span>
    )
  }

  return (
    <Heatmap
      image={markSrc}
      {...GEOMETRY}
      {...(kind === "light" ? LIGHT : DARK)}
      data-jingler-brand={kind}
      className={className}
      style={box}
    />
  )
}

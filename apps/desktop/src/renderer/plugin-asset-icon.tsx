import { forwardRef } from "react"
import { useMachine } from "@xstate/react"
import { fromPromise, setup } from "xstate"
import { Boxes, type LucideIcon, type LucideProps } from "lucide-react"

const machineFor = (src: string) =>
  setup({
    actors: {
      preload: fromPromise<void>(() =>
        new Promise<void>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve()
          image.onerror = () => reject(new Error("Plugin artwork could not be loaded."))
          image.src = src
        })
      )
    }
  }).createMachine({
    id: "pluginAssetIcon",
    initial: "loading",
    states: {
      loading: {
        invoke: {
          src: "preload",
          onDone: "ready",
          onError: "failed"
        }
      },
      ready: {},
      failed: {}
    }
  })

const cache = new Map<string, LucideIcon>()

/**
 * Turn a confined plugin SVG URL into a lucide-compatible current-colour icon.
 *
 * The standard Boxes glyph remains visible while the asset is checked and when
 * it fails. The SVG is used only as a CSS mask, so plugin-authored fills and
 * strokes cannot bypass the active theme's foreground colour.
 */
export const createPluginAssetIcon = (src: string): LucideIcon => {
  const cached = cache.get(src)
  if (cached) return cached

  const machine = machineFor(src)
  const PluginAssetIcon = forwardRef<SVGSVGElement, LucideProps>(
    ({ size = 24, color = "currentColor", absoluteStrokeWidth: _absolute, ...props }, ref) => {
      const [snapshot] = useMachine(machine)
      if (!snapshot.matches("ready")) {
        return <Boxes ref={ref} size={size} color={color} data-plugin-asset-icon="fallback" {...props} />
      }

      return (
        <svg
          ref={ref}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          color={color}
          fill="none"
          aria-hidden="true"
          data-plugin-asset-icon="ready"
          {...props}
        >
          <rect
            width="24"
            height="24"
            fill="currentColor"
            style={{
              maskImage: `url("${src}")`,
              maskPosition: "center",
              maskRepeat: "no-repeat",
              maskSize: "contain",
              WebkitMaskImage: `url("${src}")`,
              WebkitMaskPosition: "center",
              WebkitMaskRepeat: "no-repeat",
              WebkitMaskSize: "contain"
            }}
          />
        </svg>
      )
    }
  )
  PluginAssetIcon.displayName = "PluginAssetIcon"
  cache.set(src, PluginAssetIcon)
  return PluginAssetIcon
}

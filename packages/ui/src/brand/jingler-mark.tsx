import { cn } from "../lib/cn.js"
import type { SVGProps } from "react"

/**
 * The Jingler mark and wordmark.
 *
 * ## Why the path is inline and not an `<img>`
 *
 * The mark has to take its colour from the theme. It sits on the auth card, the
 * splash, the first-run screen and the empty state — four different surfaces
 * across nine themes plus anything an operator imports — and a raster or an
 * `<img src="…svg">` is a fixed colour on every one of them. `fill="currentColor"`
 * means the mark inherits, so `text-brand` on a Jingler theme and `text-blue` on
 * an imported Solarized both do the right thing without a second asset.
 *
 * The vendored files in `./assets` are still the source of truth for anything
 * OUTSIDE React — the app icons, the shader's raster input, the README, a press
 * kit. Only this path is duplicated, and it is duplicated because crossing the
 * bundler boundary is what would cost us `currentColor`.
 *
 * ## Sizing
 *
 * `viewBox` is the artwork's own 117x127 — it is TALLER THAN WIDE. Callers set
 * one dimension via a class (`size-5` gives a square box and letterboxes the
 * mark, which is usually what you want in a row); `preserveAspectRatio` keeps it
 * honest either way.
 */
export function JinglerMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 117 127"
      fill="none"
      role="img"
      aria-label="Jingler"
      className={className}
      {...props}
    >
      <path fill="currentColor" d="M115.036 31.0001C112.515 26.5574 106.89 23.8908 99.927 23.8908C89.2601 23.8908 45.8535 33.0782 20.2241 44.7814C18.4481 44.1877 17.5575 43.5939 17.1148 43.3022C19.4793 37.073 50.0001 21.6662 83.4788 9.81291C85.9996 8.92231 87.3329 6.10981 86.4424 3.58891C85.5519 1.06798 82.7393 -0.265222 80.2184 0.625308C80.0726 0.625308 61.8491 7.14611 44.2184 15.1466C10.1451 30.704 6.44241 38.8493 7.32771 44.9226C7.62461 46.9956 8.51521 48.7768 10.1403 50.256C5.69761 53.0685 2.58291 56.032 1.54651 58.9956C0.213208 62.5529 1.24971 66.256 4.21321 68.9226C6.87991 71.2924 10.5829 73.6622 14.8799 76.032C4.80691 83.4382 0.510508 91.1413 2.14031 99.1411C5.84331 116.917 39.4736 126.401 70.8803 126.401C73.5469 126.401 75.7709 124.177 75.7709 121.511C75.7709 118.844 73.5469 116.62 70.8803 116.62C37.8443 116.62 13.6923 106.693 11.7709 97.3601C10.8803 92.6204 15.6251 86.9902 25.2496 81.0626C46.2856 89.9533 74.1403 96.0271 87.0256 91.7293C93.25 89.6564 97.989 83.8752 99.171 77.0626C100.359 70.396 97.984 64.0262 92.651 59.8746C90.578 58.2444 87.9111 56.7653 84.3537 55.8746C99.911 53.3538 110.427 48.7653 114.427 42.244C116.813 38.4054 116.963 34.4064 115.036 31.0001ZM24.6668 69.8121C19.1876 67.2913 14.4428 64.4788 11.1881 61.6662C12.2246 60.3329 15.1881 58.1089 21.2611 55.1454C26.1517 56.1819 32.2247 56.9214 39.9277 57.2184C44.9641 57.5152 49.8548 57.6611 54.4491 57.5152C49.1157 58.9944 43.0428 61.2183 36.3757 64.036C32.0736 65.9631 28.0729 67.8902 24.6668 69.8121ZM86.5935 67.2965C89.8539 69.8173 89.7028 73.2236 89.406 74.9996C88.8123 78.26 86.5935 81.0725 83.7757 82.1089C75.182 84.9214 54.5877 81.0725 36.6664 74.7026C37.7029 74.2599 38.8904 73.6662 40.0727 73.2234C72.666 59.2968 83.9268 65.2236 86.5935 67.2965ZM106.296 36.7752C103.187 41.6658 85.9988 49.5148 40.5201 47.4418C43.3327 46.5512 46.4472 45.5148 49.7076 44.4782C69.4103 38.4053 91.484 33.6657 99.932 33.6657C103.786 33.6657 106.005 34.999 106.452 35.7386C106.442 35.8897 106.593 36.1866 106.296 36.7752Z" />
    </svg>
  )
}

export interface JinglerWordmarkProps {
  /** Tailwind classes for the row (sizing, gap, colour). */
  className?: string
  /** Mark size. The wordmark's type scales with the surrounding font size. */
  markClassName?: string
}

/**
 * Mark + "Jingler", the standard lockup.
 *
 * The word is TEXT, not a traced path, so it inherits the app's own
 * `--font-sans` (Hanken Grotesk) — the same face the brand's wordmark is set
 * in. Tracing it would freeze the optical size and stop it re-rendering with
 * the rest of the UI when the type scale changes.
 */
export function JinglerWordmark({ className, markClassName }: JinglerWordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <JinglerMark className={cn("h-[1.15em] w-auto text-brand", markClassName)} />
      <span className="font-semibold tracking-[-0.01em] text-text-bright">Jingler</span>
    </span>
  )
}

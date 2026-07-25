import * as React from "react"
import { cn } from "../lib/cn.js"

/**
 * A connector provider's logo.
 *
 * OpenConnector's catalog returns `iconUrl: null` for every one of its ~1,100
 * providers, but a `homepageUrl` for every one — so the logo is derived from the
 * homepage's hostname through Google's favicon service, which is exactly what
 * OOMOL Connect's own Providers page does. Consequence: the renderer's CSP must
 * allow `https://www.google.com` in `img-src` (see `renderer/index.html`), and
 * without a network the tiles quietly fall back to initials.
 *
 * `referrerPolicy="no-referrer"` so the request carries no page context, and
 * `loading="lazy"` because a 1,100-cell grid would otherwise fire ~1,100
 * requests on mount rather than the handful actually scrolled into view.
 *
 * `alt=""` is deliberate: the card wrapping this already exposes the provider
 * name as its accessible name, and a second copy here would read the name twice
 * to a screen reader and break `getByRole("button", { name })` queries.
 */

const FAVICON_ORIGIN = "https://www.google.com/s2/favicons"

/**
 * The hostname a logo can be fetched for, or null when there is nothing usable.
 * Exported because the "Homepage" link in the detail view needs the same
 * validity check — a URL we refuse to render an icon for is one we should also
 * refuse to open.
 */
export const logoHost = (homepageUrl: string | null | undefined): string | null => {
  if (!homepageUrl) return null
  try {
    const url = new URL(homepageUrl)
    // Only ever hand a real web origin to the favicon service.
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null
  } catch {
    return null
  }
}

export function ConnectorLogo({
  homepageUrl,
  iconUrl,
  name,
  size = 28,
  className
}: {
  /** The provider's own site. The favicon source. */
  readonly homepageUrl: string | null
  /** A catalog-supplied icon, when one exists — it wins over the derived favicon. */
  readonly iconUrl?: string | null
  /** Used for the fallback initial and nothing else. */
  readonly name: string
  readonly size?: number
  readonly className?: string
}) {
  const host = React.useMemo(() => logoHost(homepageUrl), [homepageUrl])
  const src = iconUrl ?? (host === null ? null : `${FAVICON_ORIGIN}?sz=64&domain=${encodeURIComponent(host)}`)

  // Keyed on `src` so switching providers re-arms the image rather than
  // inheriting the previous one's failure.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null)

  if (src === null || failedSrc === src) {
    return (
      <span
        style={{ width: size, height: size }}
        className={cn(
          "flex flex-none items-center justify-center rounded-md border border-line",
          "bg-sunken text-[12px] font-semibold text-text-bright",
          className
        )}
        aria-hidden
      >
        {name.charAt(0).toUpperCase()}
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
      style={{ width: size, height: size }}
      className={cn(
        "flex-none rounded-md border border-line bg-sunken object-contain p-0.5",
        className
      )}
    />
  )
}

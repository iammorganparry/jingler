import { getIcon } from "material-file-icons"
import { cn } from "../lib/cn.js"

const iconUrls = new Map<string, string>()

const materialIconUrl = (path: string): { name: string; url: string } => {
  const filename = path.split("/").pop() ?? path
  const icon = getIcon(filename)
  const cached = iconUrls.get(icon.name)
  if (cached !== undefined) return { name: icon.name, url: cached }
  // Render the package's static SVG as a passive image resource. This keeps the
  // Material Icon Theme artwork intact without inserting third-party markup into
  // the document with `dangerouslySetInnerHTML`.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.svg)}`
  iconUrls.set(icon.name, url)
  return { name: icon.name, url }
}

/** A Material Icon Theme glyph selected from the file's full name and extension. */
export function FileIcon({
  path,
  size = 13,
  className
}: {
  path: string | null | undefined
  size?: number
  className?: string
}) {
  const icon = materialIconUrl(path ?? "")
  return (
    <img
      src={icon.url}
      alt=""
      aria-hidden
      data-material-file-icon={icon.name}
      width={size}
      height={size}
      draggable={false}
      className={cn("shrink-0 select-none", className)}
    />
  )
}

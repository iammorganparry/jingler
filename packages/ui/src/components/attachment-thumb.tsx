import type { Attachment } from "@jingler/core"
import { ImageIcon, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { useAttachmentData } from "./attachment-source.js"

/**
 * A thumbnail for an attached image: the image (object-cover) with its filename
 * overlaid along the bottom. Pass `onRemove` to show the ✕ affordance (the
 * composer's pending attachments); omit it for a read-only transcript thumbnail.
 * Dimensions come from `className` so the same atom serves the 58px composer tile
 * and the wider transcript thumbnail.
 *
 * The bytes may not have arrived. A transcript's image attachments come over RPC
 * with `data` empty — they are 80% of a transcript's weight, so they are fetched
 * per-thumbnail instead (see `attachment-source.tsx`). The composer's own
 * attachments always have their data inline and never reach that path.
 *
 * Until the bytes land, the tile renders its FRAME and filename with a muted
 * glyph rather than a broken `<img>` or nothing at all: the layout is identical
 * either way, so a transcript does not reflow as its images arrive.
 */
export function AttachmentThumb({
  attachment,
  onRemove,
  className
}: {
  attachment: Attachment
  onRemove?: () => void
  className?: string
}) {
  const data = useAttachmentData(attachment)

  return (
    <div
      className={cn(
        "relative flex-none overflow-hidden rounded-md border border-line bg-canvas",
        className
      )}
    >
      {data === null ? (
        <div className="flex size-full items-center justify-center text-dim">
          <ImageIcon size={14} />
        </div>
      ) : (
        <img
          src={`data:${attachment.mediaType};base64,${data}`}
          alt={attachment.name}
          className="size-full object-cover"
        />
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove image"
          className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full border border-line bg-canvas/85 text-text-body outline-none transition-colors hover:bg-canvas focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={10} />
        </button>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-canvas/80 px-1.5 py-px font-mono text-[8.5px] text-muted-foreground">
        {attachment.name}
      </span>
    </div>
  )
}

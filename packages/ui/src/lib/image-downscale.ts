/**
 * Bound what an attached image costs the renderer, once, on the way IN.
 *
 * A pasted screenshot arrives at the display's real pixel size — a Retina grab is
 * routinely 3010×1882, which Chromium decodes to a ~22.7MB bitmap in order to
 * paint a 58px thumbnail. Nothing downstream ever wanted those pixels: the
 * composer tile, the transcript thumbnail and the vision API all work from far
 * less. Left uncapped they dominate everything they touch — one measured 44MB
 * transcript was 29MB of base64 images, and 185 attachments across a `~/jingler`
 * home came to 105MB of image bytes, i.e. well over a gigabyte of decoded bitmap
 * if the operator scrolls past them all.
 *
 * The cap has to land here, at ingest, rather than at render time. `data:` URLs
 * can't be re-fetched at a smaller size the way a network image can, and the
 * attachment is *persisted* — resizing on render would leave the full-size bytes
 * in the transcript for every future session to re-load.
 */

/** What `readAttachment` needs back: a MIME type and raw base64 (no `data:` prefix). */
export interface EncodedImage {
  readonly mediaType: string
  readonly data: string
}

/**
 * The longest edge an attachment keeps, in pixels.
 *
 * 1568 is not a guess: it's the largest edge Anthropic's vision API works at — it
 * downscales anything bigger itself before the model sees it. So the cap costs the
 * agent no detail it would have received anyway, while bounding the decoded bitmap
 * at ~1568² × 4B ≈ 9.8MB instead of whatever the operator's display happens to be.
 */
export const MAX_IMAGE_EDGE = 1568

/**
 * Formats we're willing to re-encode. GIF is excluded deliberately — a canvas
 * round-trip keeps the first frame and silently throws the animation away, which
 * is a worse outcome than a large attachment.
 */
const RESIZABLE: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"])

/** Lossy re-encode quality. Ignored for PNG, which is lossless either way. */
const QUALITY = 0.92

/**
 * The largest size fitting `width`×`height` inside a `max`-edge box, aspect ratio
 * preserved. Returns the input unchanged when it already fits, so callers can use
 * an identity check to decide whether any work is needed at all.
 *
 * Rounds to whole pixels and floors at 1: a 4000×1 strip must not scale to
 * 1568×0, which is not a drawable canvas.
 */
export const fitWithin = (
  width: number,
  height: number,
  max: number
): { readonly width: number; readonly height: number } => {
  const longest = Math.max(width, height)
  if (longest <= max || longest === 0) return { width, height }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/** Read a `Blob` as raw base64, dropping the `data:…;base64,` prefix. */
const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : "")
    }
    reader.onerror = () => resolve("")
    reader.readAsDataURL(blob)
  })

/** Encode a canvas back to a `Blob`, whichever canvas flavour we ended up with. */
const canvasToBlob = (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mediaType: string
): Promise<Blob | null> => {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: mediaType, quality: QUALITY }).catch(() => null)
  }
  return new Promise((resolve) => canvas.toBlob(resolve, mediaType, QUALITY))
}

/**
 * Downscale `file` to `MAX_IMAGE_EDGE` and return the re-encoded bytes.
 *
 * Returns `null` — meaning "use the original" — whenever downscaling is not the
 * right answer: an unsupported format, an image already within the cap, a
 * re-encode that came out no smaller, or an environment without the canvas APIs
 * (jsdom under test, principally). Every one of those is a legitimate outcome
 * rather than an error, so the caller's fallback is the original attachment and
 * the operator never sees a failure.
 */
export const downscaleImage = async (
  file: Blob,
  mediaType: string,
  max: number = MAX_IMAGE_EDGE
): Promise<EncodedImage | null> => {
  if (!RESIZABLE.has(mediaType.toLowerCase())) return null
  if (typeof createImageBitmap !== "function") return null

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    const fit = fitWithin(bitmap.width, bitmap.height, max)
    if (fit.width === bitmap.width && fit.height === bitmap.height) return null

    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(fit.width, fit.height)
        : Object.assign(document.createElement("canvas"), {
            width: fit.width,
            height: fit.height
          })
    // `as` because the two canvas flavours declare separate context unions that
    // don't overlap structurally, even though `drawImage` is identical on both.
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null
    if (ctx === null) return null
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height)

    const blob = await canvasToBlob(canvas, mediaType)
    // A re-encode that grew is a re-encode not worth keeping — the original bytes
    // are already on hand and cost less.
    if (blob === null || blob.size >= file.size) return null
    const data = await toBase64(blob)
    return data === "" ? null : { mediaType, data }
  } catch {
    return null
  } finally {
    // Free the full-size decode immediately rather than waiting for GC — it is
    // the single largest allocation this function makes, and the whole point.
    bitmap?.close()
  }
}

import { Either, Schema } from "effect"

const DEFAULT_MAX_BODY_BYTES = 128 * 1_024

/** Decode one bounded JSON request body with exact-property validation. */
export const decodeBoundedJson = async <A, I>(
  request: Request,
  schema: Schema.Schema<A, I>,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
): Promise<A | null> => {
  const contentLength = request.headers.get("content-length")
  if (contentLength && Number(contentLength) > maxBodyBytes) return null
  if (!request.body) return null
  try {
    const reader = request.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBodyBytes) {
        await reader.cancel()
        return null
      }
      const chunk = new Uint8Array(result.value.byteLength)
      chunk.set(result.value)
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const decoded = Schema.decodeUnknownEither(schema)(
      JSON.parse(new TextDecoder().decode(bytes)),
      { onExcessProperty: "error" }
    )
    return Either.isRight(decoded) ? decoded.right : null
  } catch {
    return null
  }
}

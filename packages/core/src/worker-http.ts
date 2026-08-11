const DEFAULT_MAX_JSON_BYTES = 16_384

export const workerJson = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  })

export const workerFields = (
  value: unknown
): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null

export const readBoundedJson = async (
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BYTES
): Promise<unknown> => {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw new Error("Request body is too large")
  }
  if (request.body === null) throw new Error("Request body is required")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      throw new Error("Request body is too large")
    }
    chunks.push(next.value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body))
}

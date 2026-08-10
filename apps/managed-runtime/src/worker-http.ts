const MAX_JSON_BYTES = 16_384

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  })

export const fields = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null

export const readJson = async (request: Request): Promise<unknown> => {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) {
    throw new Error("Request body is too large")
  }
  return request.json()
}

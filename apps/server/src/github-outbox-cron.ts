import { timingSafeEqual } from "node:crypto"

const authorized = (request: Request, secret: string): boolean => {
  if (secret === "") return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(request.headers.get("authorization") ?? "")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export const handleGitHubOutboxCron = async (
  request: Request,
  secret: string,
  drain: () => Promise<void>
): Promise<Response> => {
  if (!authorized(request, secret)) return new Response("Unauthorized", { status: 401 })
  try {
    await drain()
    return Response.json({ ok: true })
  } catch {
    return Response.json({ ok: false }, { status: 503 })
  }
}

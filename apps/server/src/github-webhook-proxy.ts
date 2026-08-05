const forwardedHeaders = [
  "content-type",
  "user-agent",
  "x-github-delivery",
  "x-github-event",
  "x-github-hook-id",
  "x-hub-signature-256"
] as const

/**
 * Preserve the production GitHub App webhook URL on api.jingler.dev while the
 * relay remains the only component that verifies and processes deliveries.
 * The body must remain byte-for-byte identical or GitHub's HMAC will fail.
 */
export const proxyGitHubWebhook = (
  request: Request,
  relayBaseUrl: string,
  fetcher: typeof fetch = fetch
): Promise<Response> => {
  const headers = new Headers()
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return fetcher(new URL("/webhooks/github", relayBaseUrl), {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    redirect: "manual"
  } as RequestInit)
}

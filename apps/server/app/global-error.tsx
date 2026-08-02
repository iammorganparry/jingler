"use client"

/**
 * Custom global error boundary. This API-only server has no UI, but App Router
 * synthesizes a `/_global-error` page and prerenders it during `next build`.
 * Next's built-in default fails to prerender here (null React dispatcher), so we
 * ship a minimal self-contained one — it renders its own `<html>`/`<body>`
 * because a global error replaces the root layout.
 */
const GlobalError = ({ error }: { error: Error & { digest?: string } }) => (
  <html lang="en">
    <body>
      <h1>Something went wrong</h1>
      {error.digest ? <p>Digest: {error.digest}</p> : null}
    </body>
  </html>
)

export default GlobalError

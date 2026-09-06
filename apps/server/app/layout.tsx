/**
 * Minimal root layout. This server is an API-only Next app — every route under
 * `app/` contains the BetterAuth/Hono catch-all route handler,
 * so there are no real pages. App Router still requires a root layout to render
 * its synthesized `/_not-found` and `/_global-error` pages during `next build`;
 * without one, prerendering those pages throws `useContext` on a null dispatcher.
 */
export const metadata = {
  title: "Jingler",
  description: "Jingler auth backend."
}

const RootLayout = ({ children }: { children: React.ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
)

export default RootLayout

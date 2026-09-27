/** The deployed auth backend (`apps/server` on Vercel). */
export const PRODUCTION_AUTH_URL = "https://api.jingler.dev"

/**
 * Point a packaged build at the production auth backend.
 *
 * Every auth consumer reads `JINGLER_AUTH_URL` lazily and falls back to
 * `http://localhost:9100` — right for tests and a local `apps/server`, wrong
 * for an installed app, which then reported "Couldn't reach the sign-in
 * service". Dev already gets production from electron.vite.config.ts, but
 * that only runs under `serve`; a packaged app has no shell environment at
 * all when launched from Finder or the Dock. An explicit value always wins,
 * so e2e and self-hosting keep working.
 */
export const applyDefaultAuthUrl = (
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): void => {
  if (packaged && !env.JINGLER_AUTH_URL) env.JINGLER_AUTH_URL = PRODUCTION_AUTH_URL
}

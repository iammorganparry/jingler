---
"@jingler/server": minor
"@jingler/desktop": minor
"@jingler/cli-adapters": minor
"@jingler/contracts": minor
"@jingler/core": minor
"@jingler/ui": minor
---

Introduce authentication and gate the desktop app behind a sign-in wall.

- New `@jingler/server` auth backend: BetterAuth over Postgres/Drizzle on Hono,
  runnable locally (`@hono/node-server` + Docker Postgres) and deployable to
  Vercel. Supports GitHub OAuth, Google OAuth, and email magic links.
- Desktop `jingler://` deep-link sign-in with the bearer token stored in the OS
  keychain (Electron `safeStorage`), a new `AuthService` + `Auth.*` RPCs, and a
  dedicated `authMachine` that gates the whole app until signed in.
- New sign-in UI: `LoginScreen` plus reusable `OAuthButton`, `AuthDivider`,
  `Starfield`, `MagicLinkForm`, and `AuthCard` components.
- Server DB access is Effect-TS: a `Database` service + per-aggregate
  Repositories (e.g. `UserRepository`), run via a `ManagedRuntime`. All
  hand-written queries go through a repository (BetterAuth's adapter is the one
  documented exception); `GET /api/me` is the first consumer.

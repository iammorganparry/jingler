# @jingler/server

## 2.0.0

### Minor Changes

- 272f34a: Introduce authentication and gate the desktop app behind a sign-in wall.

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

### Patch Changes

- Updated dependencies [3deb8c2]
- Updated dependencies [fa256c7]
- Updated dependencies [f948464]
- Updated dependencies [1eed467]
- Updated dependencies [20971db]
- Updated dependencies [f8760cf]
- Updated dependencies [c1a3c18]
- Updated dependencies [d6dbd48]
- Updated dependencies [59305ae]
- Updated dependencies [272f34a]
- Updated dependencies [142c0fe]
- Updated dependencies [42780c5]
- Updated dependencies [f842e84]
- Updated dependencies [37c10d5]
- Updated dependencies [ce51af4]
- Updated dependencies [af42847]
- Updated dependencies [eb62eb6]
- Updated dependencies [f3bb880]
- Updated dependencies [d11dbf0]
- Updated dependencies [a0292a3]
- Updated dependencies [abec0fa]
- Updated dependencies [09f4690]
- Updated dependencies [334ebfc]
- Updated dependencies [777d6d2]
- Updated dependencies [9e2539d]
- Updated dependencies [9e2539d]
- Updated dependencies [b79346f]
- Updated dependencies [304ac26]
- Updated dependencies [b419734]
- Updated dependencies [f987c20]
- Updated dependencies [e98acda]
  - @jingler/core@2.0.0

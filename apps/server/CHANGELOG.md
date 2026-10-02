# @jingler/server

## 0.5.0

### Patch Changes

- @jingler/core@0.5.0

## 0.4.1

### Patch Changes

- @jingler/core@0.4.1

## 0.4.0

### Patch Changes

- @jingler/core@0.4.0

## 0.3.6

### Patch Changes

- @jingler/core@0.3.6

## 0.3.5

### Patch Changes

- @jingler/core@0.3.5

## 0.3.4

### Patch Changes

- @jingler/core@0.3.4

## 0.3.3

### Patch Changes

- @jingler/core@0.3.3

## 0.3.2

### Patch Changes

- @jingler/core@0.3.2

## 0.3.1

### Patch Changes

- @jingler/core@0.3.1

## 0.3.0

### Minor Changes

- f3e1fe6: Add first-class WebSearch with encrypted EXA and Firecrawl credentials, managed-cloud capability sync, verified native-search seams, and desktop-only browser fallback. Headless daemons now omit client-backed browser tools entirely.

### Patch Changes

- ef6f8b4: Run Claude subscription models through the locally authenticated Claude Code CLI while keeping Pi's Jingler tools, permissions, plans, transcripts, normalized events, and native subagents. Claude setup now checks `claude auth login` instead of collecting a setup token. Legacy setup tokens and unsupported managed handoffs fail closed instead of falling back to Anthropic API traffic.
- Updated dependencies [fb08963]
- Updated dependencies [52fb0d5]
- Updated dependencies [f3e1fe6]
- Updated dependencies [58a521e]
- Updated dependencies [ddcd679]
- Updated dependencies [1b0bc36]
- Updated dependencies [89fd27c]
- Updated dependencies [32188e9]
- Updated dependencies [eb82608]
- Updated dependencies [db0ecb9]
- Updated dependencies [47fca9e]
- Updated dependencies [bd65fa1]
- Updated dependencies [2d669cd]
- Updated dependencies [5544fd8]
  - @jingler/core@0.3.0

## 0.2.1

### Patch Changes

- @jingler/core@0.2.1

## 0.2.0

### Patch Changes

- @jingler/core@0.2.0

## 0.1.3

### Patch Changes

- @jingler/core@0.1.3

## 0.1.2

### Patch Changes

- @jingler/core@0.1.2

## 0.1.1

### Patch Changes

- @jingler/core@0.1.1

## 0.1.0

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
  - @jingler/core@0.1.0

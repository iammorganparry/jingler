const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["postgres"],
  // The repo type-checks via `pnpm typecheck` (tsc) as the CI gate; the toolchain
  // is TypeScript 7 native (`typescript@7`), whose compiler API Next's build-time
  // checker can't load. `@typescript/native-preview` (a devDependency) makes Next
  // detect the native compiler and skip its own type check gracefully; this flag
  // is belt-and-suspenders so a type error never blocks the production build.
  typescript: { ignoreBuildErrors: true }
}

export default nextConfig

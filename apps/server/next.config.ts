const nextConfig = {
  // Vercel owns function tracing and packaging. Standalone output is only for
  // self-hosted builds; enabling both leaves source-level TSX imports outside
  // the deployed function.
  output: process.env.VERCEL ? undefined : "standalone",
  serverExternalPackages: ["postgres"],
  // TypeScript here is a two-compiler split, forced by the toolchain being TS 7
  // native (the Go compiler), whose JS API the Next/Vercel build tooling can't load:
  //   • Type CHECKING (the CI gate) runs TS 7 via `tsgo` — `pnpm typecheck` →
  //     `tsgo --noEmit` (@typescript/native-preview). This is the real gate.
  //   • The `typescript` package is pinned to 5.x ONLY as a JS-API shim: Vercel's
  //     `@vercel/next` builder does `require("typescript")` and calls `ts.sys.readFile`,
  //     which the native TS 7 package does not expose (it crashed the prod build).
  //     Next's own build detects native-preview and skips its check; the shim is for
  //     Vercel's separate builder step. `ignoreBuildErrors` keeps a type error from
  //     ever blocking the deploy — checking is `tsgo`'s job, not the build's.
  typescript: { ignoreBuildErrors: true }
}

export default nextConfig

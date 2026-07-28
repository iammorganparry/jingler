// Side-effect CSS imports (e.g. `@xyflow/react/dist/style.css`) — the renderer's
// bundler injects the stylesheet; the type-checker just needs to know the shape.
declare module "*.css"

// Asset imports. Vite resolves each to an emitted URL string (or an inlined
// data URL under its 4KB threshold); the type-checker only needs the string.
// Declared here rather than relying on `vite/client` because @jingler/ui ships
// raw TypeScript and is type-checked on its own, without the app's tsconfig.
declare module "*.png" {
  const src: string
  export default src
}
declare module "*.svg" {
  const src: string
  export default src
}

/**
 * Ambient declaration for side-effect CSS imports.
 *
 * Needed here because typechecking this package resolves through
 * `@jingler/ui`'s sources — the workspace ships raw TypeScript — and one of its
 * composites imports a stylesheet for its side effect. Without this, building
 * the SDK fails on a file the SDK does not own and never renders.
 */
declare module "*.css"

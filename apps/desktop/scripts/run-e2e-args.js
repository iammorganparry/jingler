/**
 * pnpm forwards `pnpm run e2e -- file.spec.ts` with a literal leading `--`.
 * Playwright treats that separator as the end of its positional test filters and
 * silently runs the whole suite. Strip only leading separators; later ones may
 * belong to an option value and are left untouched.
 */
export const normalizeE2eArgs = (args) => {
  let first = 0
  while (args[first] === "--") first += 1
  return args.slice(first)
}

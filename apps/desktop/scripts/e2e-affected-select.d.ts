export interface AffectedMapEntry {
  readonly paths: ReadonlyArray<string>
  readonly specs: ReadonlyArray<string>
}
export function matchesPattern(pattern: string, path: string): boolean
export function selectSpecs(
  changedFiles: ReadonlyArray<string>,
  map: ReadonlyArray<AffectedMapEntry>,
  allSpecs: ReadonlyArray<string>
): { specs: string[]; reason: string[] }

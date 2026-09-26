export const migrateLegacySubagentControlJournal = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(migrateLegacySubagentControlJournal)
  if (typeof value !== "object" || value === null) return value
  const migrated = Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    key === "parentPiSessionId" ? [] : [[key, migrateLegacySubagentControlJournal(entry)]]
  ))
  const legacy = "parentPiSessionId" in value ? value.parentPiSessionId : undefined
  if (!("parentRuntimeSessionId" in migrated) && typeof legacy === "string") migrated.parentRuntimeSessionId = legacy
  return migrated
}

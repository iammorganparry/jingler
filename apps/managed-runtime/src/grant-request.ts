import type { ManagedRuntimeAction } from "@jingler/core"

const managedRuntimeActions: readonly ManagedRuntimeAction[] = [
  "session.start",
  "session.input",
  "session.cancel",
  "session.observe"
]

const isManagedRuntimeAction = (value: unknown): value is ManagedRuntimeAction =>
  typeof value === "string" && managedRuntimeActions.some((action) => action === value)

export const decodeManagedGrantRequest = (value: unknown): {
  subject: string
  environmentId: string
  sessionId: string
  actions: ManagedRuntimeAction[]
  environmentGeneration: number
  reservationId: string | null
} | null => {
  if (typeof value !== "object" || value === null) return null
  const fields = Object.fromEntries(Object.entries(value))
  if (
    fields.version !== 1 ||
    typeof fields.subject !== "string" ||
    typeof fields.environmentId !== "string" ||
    typeof fields.sessionId !== "string" ||
    !(
      fields.reservationId === null ||
      (typeof fields.reservationId === "string" && fields.reservationId.length >= 8)
    ) ||
    !Array.isArray(fields.actions) ||
    !fields.actions.every(isManagedRuntimeAction) ||
    typeof fields.environmentGeneration !== "number" ||
    !Number.isSafeInteger(fields.environmentGeneration) ||
    fields.environmentGeneration < 1
  ) {
    return null
  }
  return {
    subject: fields.subject,
    environmentId: fields.environmentId,
    sessionId: fields.sessionId,
    reservationId: fields.reservationId,
    actions: fields.actions,
    environmentGeneration: fields.environmentGeneration
  }
}

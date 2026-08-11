import {
  ManagedRuntimeAction,
  ManagedRuntimeProviderSelection
} from "@jingler/core"
import { Either, Schema } from "effect"

export const ManagedGrantRegistrationRequest = Schema.Struct({
  version: Schema.Literal(1),
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  environmentId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  reservationId: Schema.NullOr(
    Schema.String.pipe(Schema.minLength(8), Schema.maxLength(128))
  ),
  actions: Schema.Array(ManagedRuntimeAction).pipe(
    Schema.minItems(1),
    Schema.maxItems(4)
  ),
  environmentGeneration: Schema.Int.pipe(Schema.positive()),
  ...ManagedRuntimeProviderSelection.fields
})
export type ManagedGrantRegistrationRequest = Schema.Schema.Type<
  typeof ManagedGrantRegistrationRequest
>

export const decodeManagedGrantRequest = (
  value: unknown
): ManagedGrantRegistrationRequest | null => {
  const decoded = Schema.decodeUnknownEither(ManagedGrantRegistrationRequest)(value, {
    onExcessProperty: "error"
  })
  return Either.isRight(decoded) ? decoded.right : null
}

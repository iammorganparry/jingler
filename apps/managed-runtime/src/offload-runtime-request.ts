import {
  OFFLOAD_COMPUTE_PROTOCOL_VERSION,
  OffloadAdmissionRequest
} from "@jingler/core"
import { Schema } from "effect"

export const OffloadRuntimePrimeRequest = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  sessionId: OffloadAdmissionRequest.fields.sessionId,
  repositorySlug: OffloadAdmissionRequest.fields.repositorySlug,
  headSha: OffloadAdmissionRequest.fields.snapshot.fields.headSha
})

export const OffloadRuntimeSandboxDestroyRequest = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
})

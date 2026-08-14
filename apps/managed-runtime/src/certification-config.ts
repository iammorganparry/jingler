import { ModelCertification } from "@jingler/core"
import { Either, Schema } from "effect"

const CertificationDocument = Schema.Array(ModelCertification).pipe(Schema.maxItems(64))

const decodeBase64 = (encoded: string): string => {
  const binary = atob(encoded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Optional non-secret certification evidence controlled by the managed-runtime
 * deployment. Production normally relies on the reviewed manifest bundled in
 * the device image; this binding exists for explicit live pre-release QA.
 */
export const managedCertificationDocument = (encoded: string | undefined): string | null => {
  if (encoded === undefined || encoded.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(decodeBase64(encoded))
    const decoded = Schema.decodeUnknownEither(CertificationDocument)(parsed, {
      onExcessProperty: "error"
    })
    return Either.isRight(decoded) ? JSON.stringify(decoded.right) : null
  } catch {
    return null
  }
}

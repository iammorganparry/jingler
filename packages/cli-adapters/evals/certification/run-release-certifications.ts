import { readFile } from "node:fs/promises"
import {
  ModelCertification,
  ReleaseCertificationManifest,
  ReleaseModelCandidate
} from "@jingler/core"
import { Cause, Data, Effect, Schema } from "effect"
import { AtomicJsonFile } from "../../src/runtime/persistence/atomic-json-file.js"
import { CORE_CAPABILITY_PROFILE } from "../pi-scenarios.js"
import { buildReleaseCertificationManifest } from "./release-certifications.js"

class ReleaseManifestCommandError extends Data.TaggedError(
  "ReleaseManifestCommandError"
)<{ readonly message: string; readonly cause?: unknown }> {}

const CandidatesDocument = Schema.Array(ReleaseModelCandidate)
const CertificationsDocument = Schema.Array(ModelCertification)

const requiredPath = (name: string): Effect.Effect<string, ReleaseManifestCommandError> => {
  const value = process.env[name]?.trim()
  return value
    ? Effect.succeed(value)
    : Effect.fail(new ReleaseManifestCommandError({ message: `${name} is required` }))
}

const readJson = (file: string): Effect.Effect<unknown, ReleaseManifestCommandError> =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) => new ReleaseManifestCommandError({
      message: `Failed to read ${file}`,
      cause
    })
  }).pipe(
    Effect.flatMap((raw) => Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: (cause) => new ReleaseManifestCommandError({
        message: `Invalid JSON in ${file}`,
        cause
      })
    }))
  )

const decodeFile = <A, I>(
  file: string,
  schema: Schema.Schema<A, I>
): Effect.Effect<A, ReleaseManifestCommandError> =>
  readJson(file).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.mapError((cause) => new ReleaseManifestCommandError({
      message: `Invalid release certification input in ${file}`,
      cause
    }))
  )

const program = Effect.gen(function* () {
  const candidatesPath = yield* requiredPath("JINGLER_RELEASE_CANDIDATES")
  const certificationsPath = yield* requiredPath("JINGLER_RELEASE_CERTIFICATIONS")
  const manifestPath = yield* requiredPath("JINGLER_RELEASE_MANIFEST")
  const [candidates, certifications] = yield* Effect.all([
    decodeFile(candidatesPath, CandidatesDocument),
    decodeFile(certificationsPath, CertificationsDocument)
  ], { concurrency: 2 })
  const manifest = yield* buildReleaseCertificationManifest({
    candidates,
    certifications,
    profiles: [CORE_CAPABILITY_PROFILE],
    generatedAt: new Date().toISOString()
  }).pipe(
    Effect.mapError((cause) => new ReleaseManifestCommandError({
      message: cause.issues.join("\n"),
      cause
    }))
  )
  const output = new AtomicJsonFile({
    file: manifestPath,
    decode: (raw) => Schema.decodeUnknownSync(Schema.parseJson(ReleaseCertificationManifest))(raw),
    fallback: () => manifest
  })
  yield* Effect.tryPromise({
    try: () => output.write(manifest),
    catch: (cause) => new ReleaseManifestCommandError({
      message: `Failed to write ${manifestPath}`,
      cause
    })
  })
  yield* Effect.sync(() => process.stdout.write(`${manifest.models.length} release models certified\n`))
})

await Effect.runPromise(program.pipe(
  Effect.catchAllCause((cause) => Effect.sync(() => {
    process.stderr.write(`${Cause.pretty(cause)}\n`)
    process.exitCode = 1
  }))
))

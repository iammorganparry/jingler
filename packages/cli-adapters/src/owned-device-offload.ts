import { OwnedDeviceOffloadResult } from "@jingler/core"
import { Effect, Schema } from "effect"
import { ToolError } from "./runtime/tools/tool-registry.js"
import type { OffloadedCommandResult, OwnedDeviceOffloadPort } from "./offload-command-router.js"

interface RemoteOwnedDeviceSession {
  readonly requestOnEnvironment: (
    environmentId: string,
    operation: string,
    payload: unknown
  ) => Effect.Effect<unknown, { readonly message: string }>
}

const chunkBytes = (bytes: Uint8Array, size = 384 * 1024): ReadonlyArray<Uint8Array> => {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)))
  }
  return chunks
}

const request = (
  remote: RemoteOwnedDeviceSession,
  deviceId: string,
  operation: string,
  payload: unknown
): Effect.Effect<unknown, ToolError> =>
  remote.requestOnEnvironment(deviceId, operation, payload).pipe(
    Effect.mapError((cause) => new ToolError(
      "execution-failed",
      `${cause.message} Offload Compute did not fall back to cloud or local execution.`,
      true
    ))
  )

export const makeOwnedDeviceOffloadPort = (
  remote: RemoteOwnedDeviceSession
): OwnedDeviceOffloadPort => ({
  execute: ({ deviceId, jobId, snapshot, command, limits, context }) => {
    const work = Effect.gen(function* () {
      const chunks = chunkBytes(snapshot.compressedBytes)
      context.progress({
        message: "Offload Compute: handing off to owned device",
        completed: 0,
        total: snapshot.compressedBytes.byteLength
      })
      yield* request(remote, deviceId, "Offload.begin", {
        jobId,
        snapshotDigest: snapshot.identity.digest,
        snapshotBytes: snapshot.uncompressedBytes,
        compressedBytes: snapshot.compressedBytes.byteLength,
        chunkCount: chunks.length,
        command,
        limits
      })
      let completed = 0
      for (const [index, chunk] of chunks.entries()) {
        yield* request(remote, deviceId, "Offload.chunk", {
          jobId,
          index,
          contentBase64: Buffer.from(chunk).toString("base64")
        })
        completed += chunk.byteLength
        context.progress({
          message: "Offload Compute: handing off to owned device",
          completed,
          total: snapshot.compressedBytes.byteLength
        })
      }
      const result = yield* request(remote, deviceId, "Offload.execute", { jobId }).pipe(
        Effect.flatMap(Schema.decodeUnknown(OwnedDeviceOffloadResult)),
        Effect.mapError((cause) => cause instanceof ToolError
          ? cause
          : new ToolError("execution-failed", "The owned device returned invalid output", true))
      )
      if (result.timedOut) {
        return yield* Effect.fail(new ToolError(
          "timed-out",
          "The owned-device command exceeded its timeout; nothing ran locally.",
          true
        ))
      }
      if (result.outputTruncated) {
        return yield* Effect.fail(new ToolError(
          "execution-failed",
          "The owned-device command exceeded its output limit; nothing ran locally.",
          true
        ))
      }
      if (result.sourceMutated) {
        return yield* Effect.fail(new ToolError(
          "execution-failed",
          "The owned-device command changed source files; its result was rejected and nothing was synced locally.",
          true
        ))
      }
      return {
        command: `${command.executable} ${command.args.join(" ")}`,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        offloaded: true,
        jobId
      } satisfies OffloadedCommandResult
    }).pipe(
      Effect.onInterrupt(() => request(remote, deviceId, "Offload.cancel", { jobId }).pipe(Effect.ignore))
    )
    const cancelled = Effect.async<never, ToolError>((resume) => {
      const onAbort = (): void => resume(Effect.fail(new ToolError(
        "cancelled",
        "Owned-device command cancelled",
        true
      )))
      context.signal.addEventListener("abort", onAbort, { once: true })
      if (context.signal.aborted) onAbort()
      return Effect.sync(() => context.signal.removeEventListener("abort", onAbort))
    })
    return Effect.raceFirst(work, cancelled)
  }
})

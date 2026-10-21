/**
 * Pinned whisper.cpp ggml models and a checksum-verified downloader. No Electron imports, so it unit-tests under node.
 * Sizes and SHA-256 come from the Hugging Face LFS pointers of `ggerganov/whisper.cpp` (`raw/main/ggml-<id>.bin`);
 * the README only publishes SHA-1, so SHA-256 is read from the LFS `oid sha256:` line.
 */
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { VoiceModel } from "@jingler/contracts"

export const WHISPER_MODELS = [
  { id: "tiny.en", sizeBytes: 77_704_715, sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f" },
  { id: "base.en", sizeBytes: 147_964_211, sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
  { id: "base", sizeBytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
  { id: "small.en", sizeBytes: 487_614_201, sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" },
  { id: "small", sizeBytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" }
] as const

export const modelFile = (dir: string, id: string): string => join(dir, `ggml-${id}.bin`)

/** Every pinned model with whether its file exists and any in-flight download's byte count. */
export const listModels = async (
  dir: string,
  downloading: ReadonlyMap<string, number>
): Promise<ReadonlyArray<VoiceModel>> =>
  Promise.all(
    WHISPER_MODELS.map(async ({ id, sizeBytes }) => ({
      id,
      sizeBytes,
      installed: (await stat(modelFile(dir, id)).catch(() => null))?.isFile() === true,
      downloading: downloading.has(id),
      receivedBytes: downloading.get(id) ?? 0
    }))
  )

export class ChecksumMismatch extends Error {
  constructor() {
    super("Downloaded model failed its SHA-256 check and was deleted")
  }
}

/** Streams `url` to `dest.part`, then moves it to `dest` only if its SHA-256 matches; otherwise deletes it and throws. */
export const downloadVerified = async (input: {
  readonly url: string
  readonly dest: string
  readonly sha256: string
  readonly onProgress: (receivedBytes: number) => void
}): Promise<void> => {
  const part = `${input.dest}.part`
  const hash = createHash("sha256")
  let received = 0
  try {
    const response = await fetch(input.url)
    if (!response.ok || response.body === null) throw new Error(`Download failed (HTTP ${response.status})`)
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk)
          received += chunk.length
          input.onProgress(received)
          yield chunk
        }
      },
      createWriteStream(part)
    )
    if (hash.digest("hex") !== input.sha256) throw new ChecksumMismatch()
    await rename(part, input.dest)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
}

/**
 * Local speech-to-text via a whisper.cpp CLI (`whisper-cli -m <model> -f <wav> -nt -np`).
 * Binary: `JINGLER_WHISPER_BIN`, else the bundled one (packaged), else `~/jingler/models/whisper/bin` (a file, or a
 * directory holding `whisper-cli`). Model: first `*.bin` in `~/jingler/models/whisper/`.
 */
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { app, systemPreferences } from "electron"
import type { VoiceModel } from "@jingler/contracts"
import { pickWhisperBinary } from "./voice-binary.js"
import { downloadVerified, listModels, modelFile, WHISPER_MODELS } from "./voice-models.js"

export type TranscribeFailure = { readonly reason: "no-model" | "failed"; readonly message: string }

const whisperDir = (): string => join(homedir(), "jingler", "models", "whisper")

const whisperBinary = (): string | null => {
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
  const bundled = app.isPackaged ? join(process.resourcesPath, "whisper", exe) : undefined
  const found = pickWhisperBinary([process.env.JINGLER_WHISPER_BIN, bundled, join(whisperDir(), "bin")], existsSync)
  if (found === null) return null
  return statSync(found).isDirectory() ? join(found, "whisper-cli") : found
}

const findModel = async (modelId?: string): Promise<string | null> => {
  if (modelId !== undefined && existsSync(modelFile(whisperDir(), modelId))) return modelFile(whisperDir(), modelId)
  const entries = await readdir(whisperDir()).catch(() => [] as string[])
  const model = entries.filter((name) => name.endsWith(".bin")).sort()[0]
  return model === undefined ? null : join(whisperDir(), model)
}

export const transcribeWav = async (
  wavBase64: string,
  language?: string,
  modelId?: string
): Promise<{ readonly text: string } | TranscribeFailure> => {
  const [binary, model] = [whisperBinary(), await findModel(modelId)]
  if (binary === null || !existsSync(binary) || model === null) {
    return { reason: "no-model", message: `Add a whisper.cpp binary and a .bin model under ${whisperDir()}` }
  }
  const dir = await mkdtemp(join(tmpdir(), "jingler-voice-"))
  try {
    const wav = join(dir, "input.wav")
    await writeFile(wav, Buffer.from(wavBase64, "base64"))
    return await new Promise((resolve) => {
      execFile(binary, ["-m", model, "-f", wav, "-nt", "-np", ...(language ? ["-l", language] : [])], { timeout: 120_000 }, (error, stdout, stderr) => {
        if (error !== null) resolve({ reason: "failed", message: stderr.trim() || error.message })
        else resolve({ text: stdout.replace(/\s+/g, " ").trim() })
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** macOS asks once (needs NSMicrophoneUsageDescription + audio-input entitlement); elsewhere Chromium decides. */
export const requestMicrophone = async (): Promise<boolean> =>
  process.platform === "darwin" && app.isPackaged
    ? systemPreferences.askForMediaAccess("microphone")
    : true

const downloading = new Map<string, number>()

export const voiceModels = (): Promise<ReadonlyArray<VoiceModel>> => listModels(whisperDir(), downloading)

const modelBaseUrl = (): string =>
  process.env.JINGLER_WHISPER_MODEL_BASE_URL ?? "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

/** E2E only: the fake server's bytes cannot match a real pinned hash, so the test supplies its own. */
const pinnedSha = (sha256: string): string =>
  process.env.JINGLER_E2E === "1" ? (process.env.JINGLER_E2E_WHISPER_SHA256 ?? sha256) : sha256

export const downloadVoiceModel = async (id: string): Promise<void> => {
  const model = WHISPER_MODELS.find((candidate) => candidate.id === id)
  if (model === undefined) throw new Error(`Unknown model ${id}`)
  if (downloading.has(id)) return
  await mkdir(whisperDir(), { recursive: true })
  downloading.set(id, 0)
  try {
    await downloadVerified({
      url: `${modelBaseUrl()}/ggml-${id}.bin`,
      dest: modelFile(whisperDir(), id),
      sha256: pinnedSha(model.sha256),
      onProgress: (received) => downloading.set(id, received)
    })
  } finally {
    downloading.delete(id)
  }
}

export const removeVoiceModel = async (id: string): Promise<void> => {
  if (WHISPER_MODELS.some((model) => model.id === id)) await rm(modelFile(whisperDir(), id), { force: true })
}

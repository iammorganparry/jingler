/**
 * Local speech-to-text via a whisper.cpp CLI (`whisper-cli -m <model> -f <wav> -nt -np`).
 * Binary: `JINGLER_WHISPER_BIN`, else `~/jingler/models/whisper/bin` (a file, or a
 * directory holding `whisper-cli`). Model: first `*.bin` in `~/jingler/models/whisper/`.
 */
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { app, systemPreferences } from "electron"

export type TranscribeFailure = { readonly reason: "no-model" | "failed"; readonly message: string }

const whisperDir = (): string => join(homedir(), "jingler", "models", "whisper")

const whisperBinary = (): string | null => {
  const configured = process.env.JINGLER_WHISPER_BIN ?? join(whisperDir(), "bin")
  if (!existsSync(configured)) return null
  return statSync(configured).isDirectory() ? join(configured, "whisper-cli") : configured
}

const findModel = async (): Promise<string | null> => {
  const entries = await readdir(whisperDir()).catch(() => [] as string[])
  const model = entries.filter((name) => name.endsWith(".bin")).sort()[0]
  return model === undefined ? null : join(whisperDir(), model)
}

export const transcribeWav = async (
  wavBase64: string
): Promise<{ readonly text: string } | TranscribeFailure> => {
  const [binary, model] = [whisperBinary(), await findModel()]
  if (binary === null || !existsSync(binary) || model === null) {
    return { reason: "no-model", message: `Add a whisper.cpp binary and a .bin model under ${whisperDir()}` }
  }
  const dir = await mkdtemp(join(tmpdir(), "jingler-voice-"))
  try {
    const wav = join(dir, "input.wav")
    await writeFile(wav, Buffer.from(wavBase64, "base64"))
    return await new Promise((resolve) => {
      execFile(binary, ["-m", model, "-f", wav, "-nt", "-np"], { timeout: 120_000 }, (error, stdout, stderr) => {
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

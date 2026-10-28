import { describe, expect, it } from "vitest"
import { pickWhisperBinary } from "./voice-binary.js"

describe("pickWhisperBinary", () => {
  const present = new Set(["/bundled/whisper-cli", "/dev/bin"])
  const exists = (path: string) => present.has(path)

  it("prefers the configured path, then bundled, then dev", () => {
    present.add("/user/whisper")
    expect(pickWhisperBinary(["/user/whisper", "/bundled/whisper-cli", "/dev/bin"], exists)).toBe("/user/whisper")
    expect(pickWhisperBinary(["/missing", "/bundled/whisper-cli", "/dev/bin"], exists)).toBe("/bundled/whisper-cli")
    expect(pickWhisperBinary([undefined, undefined, "/dev/bin"], exists)).toBe("/dev/bin")
  })

  it("returns null when nothing exists", () => {
    expect(pickWhisperBinary(["/nope", undefined], exists)).toBeNull()
  })
})

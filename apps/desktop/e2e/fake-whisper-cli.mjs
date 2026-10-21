#!/usr/bin/env node
// Stands in for whisper-cli: checks it got `-m <model> -f <wav>` and a real WAV, prints a fixed transcript.
import { appendFileSync, readFileSync } from "node:fs"
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const wav = readFileSync(arg("-f"))
if (!arg("-m")?.endsWith(".bin") || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
  console.error("bad input")
  process.exit(1)
}
if (process.env.JINGLER_FAKE_WHISPER_ARGS_LOG) appendFileSync(process.env.JINGLER_FAKE_WHISPER_ARGS_LOG, `${process.argv.slice(2).join(" ")}\n`)
console.log("  add a retry to the login test  ")

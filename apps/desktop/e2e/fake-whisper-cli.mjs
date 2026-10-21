#!/usr/bin/env node
// Stands in for whisper-cli: checks it got `-m <model> -f <wav>` and a real WAV, prints a fixed transcript.
import { readFileSync } from "node:fs"
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const wav = readFileSync(arg("-f"))
if (!arg("-m")?.endsWith(".bin") || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
  console.error("bad input")
  process.exit(1)
}
console.log("  add a retry to the login test  ")

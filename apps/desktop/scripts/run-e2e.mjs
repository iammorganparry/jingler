import { spawn } from "node:child_process"
import { normalizeE2eArgs } from "./run-e2e-args.js"

const args = normalizeE2eArgs(process.argv.slice(2))
const child = spawn("playwright", ["test", ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
})

child.on("error", (error) => {
  console.error(`Could not start Playwright: ${error.message}`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})

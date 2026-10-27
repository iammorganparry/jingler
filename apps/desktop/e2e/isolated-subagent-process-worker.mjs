import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let cwd = process.cwd()

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "init") {
    cwd = message.launch?.cwd ?? cwd
    send({ type: "ready", sessionId: "isolated-child-e2e", modelId: "anthropic/claude-sonnet-5" })
  }
  if (message.type === "prompt") {
    // The child stays running (no message_end) so its checkout is still live for Changes.
    mkdirSync(join(cwd, "src"), { recursive: true })
    writeFileSync(join(cwd, "src", "isolated.ts"), "export const isolated = true\n")
  }
  // Hold the prompt response so the child (and its checkout) outlives the Changes assertions.
  if (message.id) setTimeout(() => send({ type: "response", id: message.id, success: true }), message.type === "prompt" ? 90_000 : 0)
  if (message.type === "dispose") process.exit(0)
})

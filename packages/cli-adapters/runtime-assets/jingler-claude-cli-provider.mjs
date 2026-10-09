import { fileURLToPath } from "node:url"
import { createJiti } from "jiti"

const source = fileURLToPath(
  new URL("../src/runtime/providers/claude-cli-extension.ts", import.meta.url)
)
const load = createJiti(import.meta.url, { alias: {} })

export default async function jinglerClaudeCliProvider(pi) {
  const extension = await load.import(source)
  return extension.default(pi)
}

import { readFile, writeFile } from "node:fs/promises"
import { Message } from "@jingler/core"
import { Schema } from "effect"
import { transcriptToTrace } from "./transcript-to-trace.js"

/**
 * Convert one recorded transcript into a replay fixture:
 *
 *   pnpm --filter @jingler/cli-adapters exec tsx evals/replay/build-trace.ts \
 *     ~/jingler/transcripts/<chatId>.json plan.task-status-replay out.json
 *
 * The output is `EvalTrace[]`, ready for `JINGLER_REPLAY_TRACE` +
 * `pnpm eval:pi:replay` — or for checking in under `evals/replay/fixtures/`
 * when a session should become a permanent regression guard. The converter
 * keeps only tool names, plan checkpoint ids, and event tags; see
 * `transcript-to-trace.ts` for the sanitization contract.
 */
const [transcriptPath, scenarioId, outPath] = process.argv.slice(2)
if (transcriptPath === undefined || scenarioId === undefined) {
  throw new Error(
    "usage: tsx evals/replay/build-trace.ts <transcript.json> <scenarioId> [out.json]"
  )
}
const messages = Schema.decodeUnknownSync(Schema.Array(Message))(
  JSON.parse(await readFile(transcriptPath, "utf8"))
)
const trace = transcriptToTrace(messages, scenarioId)
const rendered = `${JSON.stringify([trace], null, 2)}\n`
if (outPath) await writeFile(outPath, rendered, "utf8")
else process.stdout.write(rendered)

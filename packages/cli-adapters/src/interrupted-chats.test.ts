import type { Session } from "@jingler/core"
import { assistantMessage, userMessage } from "@jingler/core"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, expect, it } from "vitest"
import { findInterruptedChats } from "./interrupted-chats.js"
import { withTempRoot } from "./test-support.js"
import { TranscriptStore } from "./transcripts.js"

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const at = "2026-10-01T10:00:00.000Z"
const session = (id: string, chatIds: ReadonlyArray<string>): Session =>
  ({ id, archived: false, chats: chatIds.map((chatId) => ({ id: chatId })) }) as unknown as Session

const scan = (sessions: ReadonlyArray<Session>, busy: ReadonlySet<string>) =>
  Effect.runPromise(
    findInterruptedChats(sessions, (chatId) => Effect.succeed(busy.has(chatId))).pipe(
      Effect.provide(Layer.mergeAll(TranscriptStore.Default, temp.layer))
    )
  )

const seed = (chatId: string, streaming: boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TranscriptStore.append(chatId, userMessage(`u_${chatId}`, "go", at))
      yield* TranscriptStore.append(chatId, { ...assistantMessage(`a_${chatId}`, at), streaming })
    }).pipe(Effect.provide(Layer.mergeAll(TranscriptStore.Default, temp.layer)))
  )

it("flags only a streaming tail with no live turn", async () => {
  await seed("c_dead", true)
  await seed("c_live", true)
  await seed("c_done", false)
  const found = await scan(
    [session("s1", ["c_dead", "c_live", "c_done", "c_missing"])],
    new Set(["c_live"])
  )
  expect(found).toStrictEqual([{ sessionId: "s1", chatId: "c_dead" }])
})

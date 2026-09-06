import assert from "node:assert/strict"
import { test } from "node:test"
import { parseJsonc } from "./jsonc.mjs"

test("keeps comment markers and escaped quotes inside strings", () => {
  const expected = { url: "https://example.com", quoted: 'a"//b', slash: "\\", block: "/*literal*/" }
  assert.deepEqual(parseJsonc(JSON.stringify(expected)), expected)
})

test("removes line and block comments and trailing commas", () => {
  assert.deepEqual(parseJsonc(`{
    // theme metadata
    "values": [1, /* explanation */ 2,],
  } // final comment`), { values: [1, 2] })
})

test("retains existing handling of comments after a complete document", () => {
  assert.deepEqual(parseJsonc('{"value": true} /* unfinished'), { value: true })
  assert.throws(() => parseJsonc('{"value": /* unfinished'), SyntaxError)
})

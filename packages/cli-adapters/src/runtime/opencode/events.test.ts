import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2/client"
import { describe, expect, it } from "vitest"
import { OpenCodeEvents, normalizeOpenCodeEvent } from "./events.js"

const event = (type: string, properties: unknown): Event => ({ id: 'event', type, properties }) as Event
const message = (over = {}) => ({ id: 'assistant', sessionID: 'session', parentID: 'prompt', role: 'assistant', cost: 0.02, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }, ...over })
const text = (value: string) => event('message.part.updated', { part: { id: 'text', type: 'text', sessionID: 'session', messageID: 'assistant', text: value } })

describe('OpenCode event normalization', () => {
  it('correlates a server-generated user ID and ignores later user snapshots and relay echoes', () => {
    const events = new OpenCodeEvents('session', undefined, new Set(['jingler_probe_echo']))
    expect(events.map(event('message.updated', { info: message() }))).toEqual([])
    events.map(event('message.updated', { info: { id: 'server-prompt', sessionID: 'session', role: 'user' } }))
    events.map(event('message.updated', { info: { id: 'older-prompt', sessionID: 'session', role: 'user' } }))
    events.map(event('message.updated', { info: message({ parentID: 'server-prompt' }) }))
    expect(events.map(text('reply'))).toEqual([{ _tag: 'Assistant', text: 'reply' }])
    expect(events.map(event('message.part.updated', { part: {
      id: 'tool', type: 'tool', tool: 'jingler_probe_echo', callID: 'vendor-id', sessionID: 'session', messageID: 'assistant',
      state: { status: 'completed', input: {}, output: 'owned by the relay', metadata: {} }
    } }))).toEqual([])
    expect(events.map(event('message.part.updated', { part: {
      id: 'other-tool', type: 'tool', tool: 'jingler_extra_probe_echo', callID: 'other-id', sessionID: 'session', messageID: 'assistant',
      state: { status: 'completed', input: {}, output: 'not the relay', metadata: {} }
    } }))).toMatchObject([{ _tag: 'ToolStart', name: 'jingler_extra_probe_echo' }, { _tag: 'ToolEnd' }])
  })

  it('ignores foreign sessions and prior turns, then deduplicates snapshots after deltas', () => {
    const events = new OpenCodeEvents('session', 'prompt')
    events.map(event('message.updated', { info: message({ sessionID: 'other' }) }))
    events.map(event('message.updated', { info: message({ parentID: 'old' }) }))
    expect(events.map(text('ignored'))).toEqual([])
    events.map(event('message.updated', { info: message() }))
    expect(events.map(text('hello'))).toEqual([{ _tag: 'Assistant', text: 'hello' }])
    expect(events.map(event('message.part.delta', { sessionID: 'session', messageID: 'assistant', partID: 'text', field: 'text', delta: ' world' }))).toEqual([{ _tag: 'Assistant', text: ' world' }])
    expect(events.map(text('hello world'))).toEqual([])
    expect(() => events.map(text('rewritten'))).toThrow('non-monotonically')
    events.map(event('message.updated', { info: message() }))
    expect(events.tokens).toBe(20)
    expect(events.cost).toBe(0.02)
  })
  it('normalizes completed tools and bounds output while preserving diff counts', () => {
    const events = new OpenCodeEvents('session', 'prompt')
    events.map(event('message.updated', { info: message() }))
    const tool = event('message.part.updated', { part: { id: 'tool', type: 'tool', tool: 'edit', callID: 'call', sessionID: 'session', messageID: 'assistant', state: { status: 'completed', input: { file: 'a.ts' }, output: 'x'.repeat(20000), metadata: { diff: '--- a\n+++ b\n-old\n+new' } } } })
    const normalized = events.map(tool)
    expect(normalized[0]).toMatchObject({ _tag: 'ToolStart', id: 'call', name: 'edit' })
    expect(normalized[1]).toMatchObject({ _tag: 'ToolEnd', status: 'success', diff: { added: 1, removed: 1 } })
    expect(normalized[1]?._tag === 'ToolEnd' && normalized[1].output?.length).toBe(16000)
    expect(events.map(tool)).toEqual([])
  })
  it('accepts the pinned API sync envelope and rejects oversized text or invalid usage', () => {
    const payload = { type: 'sync', id: 'sync', syncEvent: { type: 'message.updated.1', id: 'event', seq: 1, aggregateID: 'session', data: { sessionID: 'session', info: message() } } } as GlobalEvent['payload']
    const events = new OpenCodeEvents('session', 'prompt')
    events.map(normalizeOpenCodeEvent(payload)!)
    expect(() => events.map(text('x'.repeat(1_048_577)))).toThrow('bound')
    expect(() => events.map(event('message.updated', { info: message({ cost: -1 }) }))).toThrow('usage')
  })
})

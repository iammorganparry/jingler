#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
if (process.argv.includes('--version')) { console.log('codex-cli ' + ((process.env.CODEX_HOME === '0.152.0' ? '0.152.0' : '0.153.2'))); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
let initialized = false
let thread = process.env.CODEX_HOME === 'unique-threads' ? `thread-${process.pid}` : 'thread-1'
let resumed = false
let policy
let toolConfig
let systemPrompt
let pending
const note = (method, params) => send({ method, params: { threadId: thread, turnId: 'turn-1', ...params } })
const done = (status = 'completed') => note('turn/completed', { turn: { id: 'turn-1', status, error: null } })
const reply = (id, result) => send({ id, result })
const detachedSubagent = async () => {
  const client = new Client({ name: 'codex-detached-fixture', version: '1' })
  const headers = Object.fromEntries(Object.entries(toolConfig.env_http_headers).map(([header, variable]) => [header, process.env[variable]]))
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(toolConfig.url), { requestInit: { headers } }))
    const result = await client.callTool({
      name: 'subagent',
      arguments: { async: true, agent: 'worker', task: 'Detached native worker e2e; remain active until stopped.' }
    })
    const envelope = JSON.parse(result.content?.[0]?.text ?? 'null')
    if (envelope?.status !== 'running' || typeof envelope?.runId !== 'string') throw new Error('detached launch failed')
    note('item/agentMessage/delta', { itemId: 'detached-parent', delta: 'Native Codex parent settled after detached launch.' })
    done()
  } finally { await client.close() }
}
const probeRegistry = async (planning = false) => {
  if (toolConfig.default_tools_approval_mode !== 'approve' || toolConfig.tool_timeout_sec !== 86400) { done('failed'); return }
  const client = new Client({ name: 'codex-fixture', version: '1' })
  const headers = Object.fromEntries(Object.entries(toolConfig.env_http_headers).map(([header, variable]) => [header, process.env[variable]]))
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(toolConfig.url), { requestInit: { headers } }))
    const listed = await client.listTools()
    if (planning) await client.callTool({ name: 'plannotator_update_plan', arguments: { filePath: 'plan.md' } })
    const output = await client.callTool(planning ? { name: 'plannotator_submit_plan', arguments: { filePath: 'plan.md' } } : { name: 'probe_echo', arguments: {} })
    const item = { type: 'mcpToolCall', id: 'vendor-echo', server: 'jingler', tool: 'probe_echo', status: 'completed' }
    note('item/started', { item }); note('item/completed', { item })
    note('item/agentMessage/delta', { itemId: 'probe', delta: JSON.stringify({ names: listed.tools.map(t => t.name), output: output.content, inherited: systemPrompt.includes('jingler.identity-and-safety') }) })
    done()
  } finally { await client.close() }
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one compact protocol fixture intentionally enumerates prompt scenarios.
const handleTurnStart = async (id, p) => {
  const prompt = p.input[0].text
  reply(id, { turn: { id: 'turn-1' } })
  if (prompt === 'registry-probe' || prompt.startsWith('planning-probe')) { await probeRegistry(prompt.startsWith('planning-probe')); return }
  if (prompt.includes('native resumed turn')) {
    note('item/agentMessage/delta', { itemId: 'native-resumed', delta: 'Codex resumed: native resumed turn' })
    done()
    return
  }
  if (prompt.includes('native first turn')) {
    note('item/agentMessage/delta', { itemId: 'native-first', delta: 'Codex: native first turn' })
    done()
    return
  }
  if (prompt.includes('Second retained Codex parent turn')) {
    note('item/agentMessage/delta', { itemId: 'second-parent', delta: 'Native Codex second parent turn completed.' })
    done()
    return
  }
  if (prompt.includes('Launch the retained native workflow')) { await detachedSubagent(); return }
  if (prompt.includes('Detached native worker e2e; remain active until stopped.')) {
    note('item/agentMessage/delta', { itemId: 'detached-worker-progress', delta: 'Detached Codex child progress: waiting for stop.' })
    return
  }
  if (prompt === 'policy') { note('item/agentMessage/delta', { itemId: 'policy', delta: JSON.stringify(policy) }); done(); return }
  if (prompt === 'wait') { note('item/agentMessage/delta', { itemId: 'ready', delta: 'ready' }); return }
  if (['approval', 'file-approval', 'question', 'permissions'].includes(prompt)) {
    pending = true
    const method = prompt === 'permissions' ? 'item/permissions/requestApproval' : prompt === 'approval' ? 'item/commandExecution/requestApproval' : prompt === 'file-approval' ? 'item/fileChange/requestApproval' : 'item/tool/requestUserInput'
    send({ id: 'server-1', method, params: { threadId: thread, turnId: 'turn-1', itemId: 'tool-1', permissions: { fileSystem: { write: ['/tmp'] } }, questions: [{ id: 'q1', header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }], isSecret: false }] } })
    return
  }
  send({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', turnId: 'turn-1', delta: 'WRONG' } })
  note('item/agentMessage/delta', { itemId: 'a1', delta: `Codex${resumed ? " resumed" : ""}: ${prompt}` })
  note('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Thinking' })
  note('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 900000 }, last: { totalTokens: 193496 }, modelContextWindow: 258400 } })
  done()
}
const handleAccount = (method, id) => {
  if (method === 'account/read') { reply(id, { account: (process.env.CODEX_HOME === 'signed-out' || (process.env.CODEX_HOME?.includes('jingler-codex-login-') && !existsSync(join(process.env.CODEX_HOME, 'authenticated')))) ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true }); return true }
  if (method === 'account/login/start') { reply(id, { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://example.com/login', userCode: 'TEST' }); return true }
  if (method === 'account/login/cancel') { reply(id, { status: 'canceled' }); return true }
  return false
}
const handleModel = (method, id, p) => {
  if (method !== 'model/list') return false
  if (process.env.CODEX_HOME === 'many-models') reply(id, { data: Array.from({ length: 400 }, (_, i) => ({ model: "model-" + String(Math.floor(i / 2) + (p.cursor ? 100 : 0)), displayName: 'Model', supportedReasoningEfforts: [], inputModalities: ['text'] })), nextCursor: p.cursor ? null : 'page-2' })
  else reply(id, { data: [{ model: p.cursor ? 'second' : 'first', displayName: p.cursor ? 'Second' : 'First', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] }], nextCursor: p.cursor ? null : 'page-2' })
  return true
}
const handleThread = (method, id, p) => {
  if (method === 'thread/resume') { if (p.threadId === 'missing') send({ id, error: { code: -32600, message: 'thread not found' } }); else { resumed = true; thread = p.threadId; reply(id, { thread: { id: thread } }) }; return true }
  if (method === 'thread/fork') { thread = 'forked-thread'; reply(id, { thread: { id: thread } }); return true }
  if (method === 'thread/start') { reply(id, { thread: { id: thread } }); return true }
  return false
}
const handleTurn = (method, id, p) => {
  if (method === 'turn/start') { handleTurnStart(id, p).catch(() => done('failed')); return true }
  if (method === 'turn/steer') {
    reply(id, { turnId: 'turn-1' })
    const prompt = p.input[0].text
    const retainedSecondTurn = prompt.includes('Second retained Codex parent turn')
    const nativeResume = prompt.includes('native resumed turn')
    note('item/agentMessage/delta', {
      itemId: 'a1',
      delta: retainedSecondTurn
        ? 'Native Codex second parent turn completed.'
        : nativeResume
          ? 'Codex resumed: native resumed turn'
          : prompt
    })
    if (retainedSecondTurn || nativeResume) done()
    return true
  }
  if (method === 'turn/interrupt') { reply(id, {}); done('interrupted'); return true }
  return false
}
const handleFailure = (method) => {
  if (method === 'malformed') process.stdout.write('{broken\n')
  else if (method === 'oversized') process.stdout.write('x'.repeat(10000))
  else if (method === 'exit') process.exit(1)
  else if (method !== 'timeout') return false
  return true
}
const handleMessage = (message) => {
  const { id, method, params: p } = message
  if (method === 'thread/start' || method === 'thread/resume') { toolConfig = p.config?.mcp_servers?.jingler; systemPrompt = p.developerInstructions }
  if (method === 'thread/start' || method === 'thread/resume') policy = { approvalPolicy: p.approvalPolicy, sandbox: p.sandbox, approvalsReviewer: p.approvalsReviewer }
  if (method === 'initialize') { reply(id, { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' }); return }
  if (method === 'initialized') { initialized = true; return }
  if (!initialized) { send({ id, error: { code: -1, message: 'Not initialized' } }); return }
  if (!method && pending) { note('item/agentMessage/delta', { itemId: 'answer', delta: JSON.stringify(message.result) }); pending = false; done(); return }
  if (handleAccount(method, id) || handleModel(method, id, p) || handleThread(method, id, p) || handleTurn(method, id, p) || handleFailure(method)) return
  reply(id, {})
}
createInterface({ input: process.stdin }).on('line', line => handleMessage(JSON.parse(line)))

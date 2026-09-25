#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
if (process.argv.includes('--version')) { console.log('codex-cli ' + ((process.env.CODEX_HOME === '0.152.0' ? '0.152.0' : '0.153.2'))); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
let initialized = false
let thread = 'thread-1'
let resumed = false
let policy
let pending
const note = (method, params) => send({ method, params: { threadId: thread, turnId: 'turn-1', ...params } })
const done = (status = 'completed') => note('turn/completed', { turn: { id: 'turn-1', status, error: null } })
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: deterministic protocol fixture keeps all method responses together.
createInterface({ input: process.stdin }).on('line', line => {
 const message = JSON.parse(line)
 const { id, method, params: p } = message
 const reply = result => send({ id, result })
 if (method === 'thread/start' || method === 'thread/resume') policy = { approvalPolicy: p.approvalPolicy, sandbox: p.sandbox, approvalsReviewer: p.approvalsReviewer }
 if (method === 'initialize') { reply({ userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' }); return }
 if (method === 'initialized') { initialized = true; return }
 if (!initialized) { send({ id, error: { code: -1, message: 'Not initialized' } }); return }
 if (!method && pending) {
   note('item/agentMessage/delta', { itemId: 'answer', delta: JSON.stringify(message.result) }); pending = false; done(); return
 }
 switch (method) {
 case 'account/read': reply({ account: (process.env.CODEX_HOME === 'signed-out' || (process.env.CODEX_HOME?.includes('jingler-codex-login-') && !existsSync(join(process.env.CODEX_HOME, 'authenticated')))) ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true }); break
 case 'account/login/start': reply({ type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://example.com/login', userCode: 'TEST' }); break
 case 'account/login/cancel': reply({ status: 'canceled' }); break
 case 'model/list': if (process.env.CODEX_HOME === 'many-models') { reply({ data: Array.from({ length: 400 }, (_, i) => ({ model: "model-" + String(Math.floor(i / 2) + (p.cursor ? 100 : 0)), displayName: 'Model', supportedReasoningEfforts: [], inputModalities: ['text'] })), nextCursor: p.cursor ? null : 'page-2' }); break } reply({ data: [{ model: p.cursor ? 'second' : 'first', displayName: p.cursor ? 'Second' : 'First', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] }], nextCursor: p.cursor ? null : 'page-2' }); break
 case 'thread/resume':
   if (p.threadId === 'missing') { send({ id, error: { code: -32600, message: 'thread not found' } }); break }
   resumed = true; thread = p.threadId; reply({ thread: { id: thread } }); break
 case 'thread/fork': thread = 'forked-thread'; reply({ thread: { id: thread } }); break
 case 'thread/start': reply({ thread: { id: thread } }); break
 case 'turn/start': {
   const prompt = p.input[0].text
   reply({ turn: { id: 'turn-1' } })
   if (prompt === 'policy') { note('item/agentMessage/delta', { itemId: 'policy', delta: JSON.stringify(policy) }); done(); break }
   if (prompt === 'wait') { note('item/agentMessage/delta', { itemId: 'ready', delta: 'ready' }); break }
   if (prompt === 'approval' || prompt === 'file-approval' || prompt === 'question' || prompt === 'permissions') {
     pending = true
     send({ id: 'server-1', method: prompt === 'permissions' ? 'item/permissions/requestApproval' : prompt === 'approval' ? 'item/commandExecution/requestApproval' : prompt === 'file-approval' ? 'item/fileChange/requestApproval' : 'item/tool/requestUserInput', params: {
       threadId: thread, turnId: 'turn-1', itemId: 'tool-1', permissions: { fileSystem: { write: ['/tmp'] } }, questions: [{ id: 'q1', header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }], isSecret: false }]
     } }); break
   }
   send({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', turnId: 'turn-1', delta: 'WRONG' } })
   note('item/agentMessage/delta', { itemId: 'a1', delta: `Codex${resumed ? " resumed" : ""}: ${prompt}` })
   note('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Thinking' })
   note('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 900000 }, last: { totalTokens: 193496 }, modelContextWindow: 258400 } })
   done(); break
 }
 case 'turn/steer': reply({ turnId: 'turn-1' }); note('item/agentMessage/delta', { itemId: 'a1', delta: p.input[0].text }); break
 case 'turn/interrupt': reply({}); done('interrupted'); break
 case 'malformed': process.stdout.write('{broken\n'); break
 case 'oversized': process.stdout.write('x'.repeat(10000)); break
 case 'exit': process.exit(1); break
 case 'timeout': break
 default: reply({})
 }
})

import { createServer } from "node:net"

let buffer = Buffer.alloc(0)
let output = process.stdout
let sequence = 0
let line = 3
let pendingStart
const capabilities = { supportsTerminateRequest: true, supportsFunctionBreakpoints: true, supportsInstructionBreakpoints: true, supportsDataBreakpoints: true, supportsDisassembleRequest: true, supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true, supportsModulesRequest: true, supportsLoadedSourcesRequest: true }
if (process.env.FAKE_DAP_NO_CONFIGURATION_DONE !== "1") capabilities.supportsConfigurationDoneRequest = true
const send = (message) => {
  const body = JSON.stringify({ seq: ++sequence, ...message })
  output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const response = (request, body = {}) => send({ type: "response", request_seq: request.seq, success: true, command: request.command, body })
const failure = (request, message) => send({ type: "response", request_seq: request.seq, success: false, command: request.command, message })
const event = (name, body = {}) => send({ type: "event", event: name, body })
const start = (request, reason) => {
  event("initialized")
  if (process.env.FAKE_DAP_NO_CONFIGURATION_DONE === "1") {
    response(request)
    setTimeout(() => event("stopped", { reason, threadId: 1 }), 5)
  } else {
    pendingStart = { request, reason }
  }
}
const initialize = (request) => request.arguments?.supportsRunInTerminalRequest === true
  ? failure(request, "runInTerminal must not be advertised")
  : response(request, capabilities)
const configurationDone = (request) => {
  if (process.env.FAKE_DAP_NO_CONFIGURATION_DONE === "1") {
    process.exit(8)
    return
  }
  response(request)
  if (!pendingStart) return
  const pending = pendingStart
  pendingStart = undefined
  response(pending.request)
  setTimeout(() => event("stopped", { reason: pending.reason, threadId: 1 }), 5)
}
const step = (request) => {
  if (process.env.FAKE_DAP_REJECT_STEP === "1") {
    failure(request, "step rejected")
    return
  }
  response(request, { allThreadsContinued: true })
  event("continued", { threadId: 1 })
  line += 1
  setTimeout(() => event("stopped", { reason: "step", threadId: 1 }), 5)
}
const handlers = {
  initialize,
  launch: (request) => { start(request, "entry"); },
  attach: (request) => { start(request, "attach"); },
  threads: (request) => { response(request, { threads: [{ id: 1, name: "main" }] }); },
  stackTrace: (request) => {
    const requestedLine = line
    const reply = () => response(request, { stackFrames: [{ id: 10, name: "main", source: { path: process.env.FAKE_DAP_SOURCE }, line: requestedLine, column: 1, instructionPointerReference: "0x1" }] })
    if (process.env.FAKE_DAP_RACE_STACK === "1" && requestedLine === 4) setTimeout(reply, 30)
    else reply()
  },
  scopes: (request) => { response(request, { scopes: [{ name: "Locals", variablesReference: 20, expensive: false }] }); },
  variables: (request) => {
    if (process.env.FAKE_DAP_VARIABLES_FAIL_AT === String(line)) failure(request, "variables unavailable")
    else response(request, { variables: [{ name: "count", value: String(line), type: "number", variablesReference: 0 }] })
  },
  evaluate: (request) => { response(request, { result: request.arguments?.expression === "count" ? String(line) : "unknown", type: "number", variablesReference: 0 }); },
  setBreakpoints: (request) => { response(request, { breakpoints: (request.arguments?.breakpoints ?? []).map((point, index) => ({ id: index + 1, verified: true, line: point.line })) }); },
  setFunctionBreakpoints: (request) => { response(request, { breakpoints: [] }); },
  setInstructionBreakpoints: (request) => { response(request, { breakpoints: [] }); },
  setDataBreakpoints: (request) => { response(request, { breakpoints: [] }); },
  dataBreakpointInfo: (request) => { response(request, { dataId: "count", description: "count", accessTypes: ["write"], canPersist: false }); },
  continue: step,
  next: step,
  stepIn: step,
  stepOut: step,
  pause: (request) => { response(request); setTimeout(() => event("stopped", { reason: "pause", threadId: 1 }), 5); },
  disassemble: (request) => { response(request, { instructions: [{ address: "0x1", instruction: "nop" }] }); },
  readMemory: (request) => { response(request, { address: "0x1", data: "AA==" }); },
  writeMemory: (request) => { response(request, { bytesWritten: 1 }); },
  modules: (request) => { response(request, { modules: [{ id: 1, name: "fake" }] }); },
  loadedSources: (request) => { response(request, { sources: [{ path: process.env.FAKE_DAP_SOURCE }] }); },
  raceStops: (request) => { response(request); line = 4; event("stopped", { reason: "race", threadId: 1 }); line = 5; event("stopped", { reason: "race", threadId: 1 }); },
  crashAdapter: () => { process.exit(7); },
  configurationDone,
  terminate: (request) => { response(request); event("terminated"); },
  disconnect: (request) => { response(request); setTimeout(() => process.exit(0), 5); },
}
const handle = (request) => {
  const handler = Object.hasOwn(handlers, request.command) ? handlers[request.command] : null
  if (handler) handler(request)
  else response(request, { echoed: request.command })
}
const CONTENT_LENGTH = /Content-Length:\s*(\d+)/iu
const receive = (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) break
    const match = CONTENT_LENGTH.exec(buffer.subarray(0, end).toString())
    if (!match) process.exit(2)
    const length = Number(match[1])
    if (buffer.length < end + 4 + length) break
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    handle(message)
  }
}
const portIndex = process.argv.indexOf("--port")
if (portIndex >= 0) {
  const port = Number(process.argv[portIndex + 1])
  createServer((socket) => {
    output = socket
    socket.on("data", receive)
  }).listen(port, "127.0.0.1")
} else {
  process.stdin.on("data", receive)
}

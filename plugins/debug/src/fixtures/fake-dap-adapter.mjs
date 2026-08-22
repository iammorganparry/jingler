import { createServer } from "node:net"

let buffer = Buffer.alloc(0)
let output = process.stdout
let sequence = 0
let line = 3
let pendingStart
const send = (message) => {
  const body = JSON.stringify({ seq: ++sequence, ...message })
  output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const response = (request, body = {}) => send({ type: "response", request_seq: request.seq, success: true, command: request.command, body })
const failure = (request, message) => send({ type: "response", request_seq: request.seq, success: false, command: request.command, message })
const event = (name, body = {}) => send({ type: "event", event: name, body })
const handle = (request) => {
  switch (request.command) {
    case "initialize": response(request, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true, supportsFunctionBreakpoints: true, supportsInstructionBreakpoints: true, supportsDataBreakpoints: true, supportsDisassembleRequest: true, supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true, supportsModulesRequest: true, supportsLoadedSourcesRequest: true }); break
    case "launch": pendingStart = { request, reason: "entry" }; event("initialized"); break
    case "attach": pendingStart = { request, reason: "attach" }; event("initialized"); break
    case "threads": response(request, { threads: [{ id: 1, name: "main" }] }); break
    case "stackTrace": response(request, { stackFrames: [{ id: 10, name: "main", source: { path: process.env.FAKE_DAP_SOURCE }, line, column: 1, instructionPointerReference: "0x1" }] }); break
    case "scopes": response(request, { scopes: [{ name: "Locals", variablesReference: 20, expensive: false }] }); break
    case "variables": process.env.FAKE_DAP_VARIABLES_FAIL_AT === String(line)
      ? failure(request, "variables unavailable")
      : response(request, { variables: [{ name: "count", value: String(line), type: "number", variablesReference: 0 }] }); break
    case "evaluate": response(request, { result: request.arguments?.expression === "count" ? String(line) : "unknown", type: "number", variablesReference: 0 }); break
    case "setBreakpoints": response(request, { breakpoints: (request.arguments?.breakpoints ?? []).map((point, index) => ({ id: index + 1, verified: true, line: point.line })) }); break
    case "setFunctionBreakpoints": case "setInstructionBreakpoints": case "setDataBreakpoints": response(request, { breakpoints: [] }); break
    case "dataBreakpointInfo": response(request, { dataId: "count", description: "count", accessTypes: ["write"], canPersist: false }); break
    case "configurationDone": response(request); if (pendingStart) { const start = pendingStart; pendingStart = undefined; response(start.request); setTimeout(() => event("stopped", { reason: start.reason, threadId: 1 }), 5) } break
    case "continue": case "next": case "stepIn": case "stepOut": response(request, { allThreadsContinued: true }); event("continued", { threadId: 1 }); line += 1; setTimeout(() => event("stopped", { reason: "step", threadId: 1 }), 5); break
    case "pause": response(request); setTimeout(() => event("stopped", { reason: "pause", threadId: 1 }), 5); break
    case "disassemble": response(request, { instructions: [{ address: "0x1", instruction: "nop" }] }); break
    case "readMemory": response(request, { address: "0x1", data: "AA==" }); break
    case "writeMemory": response(request, { bytesWritten: 1 }); break
    case "modules": response(request, { modules: [{ id: 1, name: "fake" }] }); break
    case "loadedSources": response(request, { sources: [{ path: process.env.FAKE_DAP_SOURCE }] }); break
    case "terminate": response(request); event("terminated"); break
    case "disconnect": response(request); setTimeout(() => process.exit(0), 5); break
    default: response(request, { echoed: request.command })
  }
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

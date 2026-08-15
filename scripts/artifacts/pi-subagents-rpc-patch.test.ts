import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execute = promisify(execFile)

describe("Jingler pi-subagents RPC patch", () => {
  it("acknowledges an exact native supervisor reply without an active model turn", async () => {
    const rpcUrl = pathToFileURL(
      resolve("node_modules/pi-subagents/src/extension/rpc.ts")
    ).href
    const piUrl = pathToFileURL(
      resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")
    ).href
    const script = `
      import { createJiti } from "jiti";
      import { createEventBus } from ${JSON.stringify(piUrl)};
      const jiti = createJiti(import.meta.url);
      const { registerSubagentRpcBridge } = await jiti.import(${JSON.stringify(rpcUrl)});
      const events = createEventBus();
      const bridge = registerSubagentRpcBridge({
        events,
        getContext: () => null,
        execute: () => Promise.reject(new Error("execute must not be called")),
        replySupervisor: (requestId, message) => ({
          requestId,
          runId: "run-1",
          agent: message === "Use the public API" ? "worker" : "unexpected"
        })
      });
      events.on("subagents:rpc:v1:reply:reply-1", (reply) => {
        process.stdout.write(JSON.stringify(reply));
        bridge.dispose();
      });
      events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId: "reply-1",
        method: "reply",
        params: { requestId: "attention-1", message: "Use the public API" },
        source: { extension: "jingler" }
      });
    `

    const { stdout } = await execute(process.execPath, [
      "--input-type=module",
      "--eval",
      script
    ])

    expect(JSON.parse(stdout)).toMatchObject({
      version: 1,
      requestId: "reply-1",
      method: "reply",
      success: true,
      data: {
        requestId: "attention-1",
        runId: "run-1",
        agent: "worker"
      }
    })
  }, 15_000)
})

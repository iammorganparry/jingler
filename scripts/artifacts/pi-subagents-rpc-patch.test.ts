import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const REMOVED_PROMPT_PATCH = /PROMPT_REDACTED|task: progress\.task|task: result\.task/u
const CHANGED_PATCH_LINE = /^[+-](?![+-])/u

describe("Jingler pi-subagents compatibility patch", () => {
  it("contains only the four host compatibility fixes", async () => {
    const patch = await readFile("patches/pi-subagents@0.57.0.patch", "utf8")
    const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gmu)]
      .map(([, file]) => file)
    expect(files).toEqual([
      "src/extension/index.ts",
      "src/extension/rpc.ts",
      "src/intercom/native-supervisor-channel.ts",
      "src/runs/background/subagent-runner.ts",
      "src/runs/foreground/execution.ts",
      "src/runs/shared/pi-spawn.ts"
    ])
    const changedLines = patch.split("\n")
      .filter((line) => CHANGED_PATCH_LINE.test(line))
      .join("\n")
    expect(changedLines).not.toMatch(REMOVED_PROMPT_PATCH)
  })

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

  it("prepends managed wrapper arguments to the pinned Pi executable", async () => {
    const spawnUrl = pathToFileURL(
      resolve("node_modules/pi-subagents/src/runs/shared/pi-spawn.ts")
    ).href
    const script = `
      import { createJiti } from "jiti";
      const jiti = createJiti(import.meta.url);
      const { getPiSpawnCommand, getPiSpawnEnv } = await jiti.import(${JSON.stringify(spawnUrl)});
      const env = {
        PI_SUBAGENT_PI_BINARY: "/managed/node",
        PI_SUBAGENT_PI_BINARY_ARGS: JSON.stringify(["/managed/wrapper.mjs"]),
        PI_SUBAGENT_ELECTRON_RUN_AS_NODE: "1"
      };
      process.stdout.write(JSON.stringify({
        command: getPiSpawnCommand(["--model", "test"], { env }),
        env: getPiSpawnEnv(env)
      }));
    `

    const { stdout } = await execute(process.execPath, [
      "--input-type=module",
      "--eval",
      script
    ])

    expect(JSON.parse(stdout)).toEqual({
      command: {
        command: "/managed/node",
        args: ["/managed/wrapper.mjs", "--model", "test"]
      },
      env: {
        PI_SUBAGENT_PI_BINARY: "/managed/node",
        PI_SUBAGENT_PI_BINARY_ARGS: JSON.stringify(["/managed/wrapper.mjs"]),
        PI_SUBAGENT_ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_RUN_AS_NODE: "1"
      }
    })
  }, 15_000)

  it("starts the packaged Electron executable in Node mode before the wrapper", async () => {
    const spawnUrl = pathToFileURL(
      resolve("node_modules/pi-subagents/src/runs/shared/pi-spawn.ts")
    ).href
    const electronPath = require("electron") as string
    const script = `
      import { spawnSync } from "node:child_process";
      import { createJiti } from "jiti";
      const jiti = createJiti(import.meta.url);
      const { getPiSpawnEnv } = await jiti.import(${JSON.stringify(spawnUrl)});
      const env = getPiSpawnEnv({
        PATH: "",
        PI_SUBAGENT_ELECTRON_RUN_AS_NODE: "1"
      });
      const child = spawnSync(${JSON.stringify(electronPath)}, [
        "--eval",
        "process.stdout.write(JSON.stringify({node: process.release.name, electron: process.versions.electron}))"
      ], { env, encoding: "utf8" });
      if (child.status !== 0) throw new Error(child.stderr || "Electron node-mode launch failed");
      process.stdout.write(child.stdout);
    `

    const { stdout } = await execute(process.execPath, [
      "--input-type=module",
      "--eval",
      script
    ])

    expect(JSON.parse(stdout)).toMatchObject({ node: "node" })
  }, 15_000)
})

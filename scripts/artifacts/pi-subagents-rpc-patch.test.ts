import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execute = promisify(execFile)
const REMOVED_PROMPT_PATCH = /PROMPT_REDACTED|task: progress\.task|task: result\.task/u
const CHANGED_PATCH_LINE = /^[+-](?![+-])/u

describe("Jingler pi-subagents compatibility patch", () => {
  it("contains only Jingler host compatibility changes", async () => {
    const patch = await readFile("patches/pi-subagents@0.65.0.patch", "utf8")
    const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gmu)]
      .map(([, file]) => file)
    expect(files).toEqual([
      "src/extension/index.ts",
      "src/extension/rpc.ts",
      "src/intercom/native-supervisor-channel.ts",
      "src/runs/background/async-execution.ts",
      "src/runs/foreground/execution.ts",
      "src/runs/shared/process-child-session-worker.ts",
      "src/runs/shared/process-child-session.ts"
    ])
    expect(patch.split("\n").filter((line) => CHANGED_PATCH_LINE.test(line)).join("\n"))
      .not.toMatch(REMOVED_PROMPT_PATCH)
  })

  it("drops a cached UI context after Pi replaces its session", async () => {
    const contextUrl = pathToFileURL(
      resolve("node_modules/pi-subagents/src/shared/extension-context.ts")
    ).href
    const script = `
      import { createJiti } from "jiti";
      const { withCachedUiContext } = await createJiti(import.meta.url).import(${JSON.stringify(contextUrl)});
      let cleared = false;
      const stale = { get hasUI() { throw new Error("This extension ctx is stale after session replacement or reload."); } };
      const result = withCachedUiContext(stale, () => { cleared = true; }, () => "rendered");
      process.stdout.write(JSON.stringify({ result: result ?? null, cleared }));
    `
    const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script])
    expect(JSON.parse(stdout)).toEqual({ result: null, cleared: true })
  }, 15_000)

  it("acknowledges a native supervisor reply without an active model turn", async () => {
    const rpcUrl = pathToFileURL(resolve("node_modules/pi-subagents/src/extension/rpc.ts")).href
    const piUrl = pathToFileURL(
      resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")
    ).href
    const script = `
      import { createJiti } from "jiti";
      import { createEventBus } from ${JSON.stringify(piUrl)};
      const { registerSubagentRpcBridge } = await createJiti(import.meta.url).import(${JSON.stringify(rpcUrl)});
      const events = createEventBus();
      const bridge = registerSubagentRpcBridge({
        events,
        getContext: () => null,
        execute: () => Promise.reject(new Error("execute must not be called")),
        replySupervisor: (requestId, message) => ({ requestId, runId: "run-1", agent: message === "Use the public API" ? "worker" : "unexpected" })
      });
      events.on("subagents:rpc:v1:reply:reply-1", (reply) => { process.stdout.write(JSON.stringify(reply)); bridge.dispose(); process.exit(0); });
      events.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId: "reply-1",
        method: "reply",
        params: { requestId: "attention-1", message: "Use the public API" },
        source: { extension: "jingler" }
      });
    `
    const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script])
    expect(JSON.parse(stdout)).toMatchObject({
      success: true,
      data: { requestId: "attention-1", runId: "run-1", agent: "worker" }
    })
  }, 15_000)

  it("runs child sessions in a credential-scoped process", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-process-child-"))
    const parent = "parent-session"
    const agent = "worker"
    const agentDir = join(root, createHash("sha256").update(parent).digest("hex"))
    const fakePi = join(root, "fake-pi.mjs")
    await mkdir(agentDir, { recursive: true })
    await Promise.all([
      writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 }),
      writeFile(join(agentDir, `capability-${agent}.json`), "{}", { mode: 0o600 }),
      writeFile(fakePi, `
        export const ModelRuntime = { create: async () => ({ registerProvider() {}, registerNativeProvider() {} }) };
        export const SettingsManager = { create: () => ({}) };
        export class DefaultResourceLoader {
          async reload() {}
          getExtensions() { return { runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } }; }
        }
        export const SessionManager = { inMemory: () => ({}) };
        export const resolveCliModel = () => ({ model: { provider: "test", id: "model" } });
        export const createAgentSession = async () => {
          const listeners = new Set();
          const emit = (event) => { for (const listener of listeners) listener(event); };
          return { session: {
            bindExtensions: async () => {},
            extensionRunner: { hasHandlers: () => false },
            subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
            prompt: async () => {
              emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], workerPid: process.pid } });
              emit({ type: "agent_settled" });
            },
            steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose() {},
            messages: [], sessionFile: undefined, sessionId: "child-session", model: { provider: "test", id: "model" }
          } };
        };
      `)
    ])
    const factoryUrl = pathToFileURL(
      resolve("node_modules/pi-subagents/src/runs/shared/process-child-session.ts")
    ).href
    const script = `
      import { createJiti } from "jiti";
      const { createProcessChildSessionFactory } = await createJiti(import.meta.url).import(${JSON.stringify(factoryUrl)});
      const factory = createProcessChildSessionFactory();
      const child = await factory.create({
        cwd: ${JSON.stringify(root)}, storage: { kind: "memory" }, model: "test/model",
        extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true,
        runtime: { parentSessionId: ${JSON.stringify(parent)}, agent: ${JSON.stringify(agent)}, fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false }
      });
      const events = [];
      child.subscribe((event) => events.push(event));
      await child.prompt("hello");
      await child.dispose();
      process.stdout.write(JSON.stringify({ events, parentPid: process.pid }));
    `
    try {
      const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script], {
        env: {
          ...process.env,
          JINGLER_SUBAGENT_CREDENTIAL_ROOT: root,
          JINGLER_SUBAGENT_NODE: process.execPath,
          JITI_ALIAS: JSON.stringify({ "@earendil-works/pi-coding-agent": fakePi })
        }
      })
      const result = JSON.parse(stdout)
      const message = result.events.find((event: { type: string }) => event.type === "message_end")
      expect(message.message.workerPid).not.toBe(result.parentPid)
      expect(message.message.content[0].text).toBe("done")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})

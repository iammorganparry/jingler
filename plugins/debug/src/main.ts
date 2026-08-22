import type { Activate, HostContext } from "@jingler/plugin-sdk/host"
import {
  decodeDebugControl,
  decodeDebugHover,
  decodeDebugRoute,
  type DebugRoute
} from "./contracts.js"
import { DebugController } from "./controller.js"
import { debugAgentTool } from "./tool.js"

const trustedRoute = async (
  ctx: Pick<HostContext, "sessions">,
  route: DebugRoute
): Promise<DebugRoute> => {
  const session = await ctx.sessions.get(route.sessionId)
  if (!session?.worktreePath) throw new Error("Debugging requires an open session with a worktree.")
  return { sessionId: session.id }
}

export const activate: Activate = (ctx) => {
  const controller = new DebugController()
  const reportCleanup = (cause: unknown) => ctx.log.warn(
    `Debug cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`
  )
  const closed = ctx.events.on((event) => {
    if (event.type === "session-closed") controller.disposeSession(event.sessionId).catch(reportCleanup)
  })
  ctx.subscriptions.push(
    ctx.agentTools.registerToolset({ id: "debug.dap", tools: [debugAgentTool(controller)] }),
    ctx.commands.register("debug.snapshot", async (value) =>
      controller.snapshot((await trustedRoute(ctx, decodeDebugRoute(value))).sessionId)
    ),
    ctx.commands.register("debug.control", async (value) => {
      const input = decodeDebugControl(value)
      await trustedRoute(ctx, input)
      return controller.control(input)
    }),
    ctx.commands.register("debug.hover", async (value) => {
      const input = decodeDebugHover(value)
      await trustedRoute(ctx, input)
      return controller.hover(input)
    }),
    closed,
    { dispose: () => { controller.dispose().catch(reportCleanup) } }
  )
  ctx.log.info("DAP debugger ready")
}

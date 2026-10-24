import { isPlanWritePathAllowed } from "@jingler/plannotator-ext/tool-scope.ts"
import { ToolError } from "./tool-registry.js"

const READ_COMMANDS = new Set(["ls", "cat", "head", "tail", "rg", "grep", "find", "wc", "pwd", "echo"])
const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch"])
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"])
const DENIED_FLAG = /^(-delete|-exec|-execdir|-ok|-okdir|-fprint\w*|-fls|--pre(=.*)?|--pre-glob(=.*)?|--output(=.*)?|--ext-diff|--textconv|--hostname-bin(=.*)?)$/

/**
 * Deny by default: a command passes only if it has no shell metacharacters
 * (redirects, pipes, chaining, substitution, expansion) and is a known
 * read-only program with no flag that executes or writes.
 */
export const isReadOnlyCommand = (command: string): boolean => {
  if (/[;&|<>`$()\n\r\\{}]/.test(command)) return false
  const [program, ...args] = command.trim().split(/\s+/)
  if (program === undefined) return false
  if (args.some((arg) => DENIED_FLAG.test(arg))) return false
  if (program === "git") {
    const [sub, ...rest] = args
    if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) return false
    return sub !== "branch" || rest.every((arg) => GIT_BRANCH_FLAGS.has(arg))
  }
  return READ_COMMANDS.has(program)
}

/** Per-call plan-mode checks for the tools the registry admits conditionally. */
export const assertPlanCall = (toolId: string, input: { readonly path?: string; readonly command?: string }, cwd: string): void => {
  if (toolId === "command_execute") {
    if (!isReadOnlyCommand(input.command ?? "")) {
      throw new ToolError("forbidden", "Plan mode allows only read-only commands (ls, cat, head, tail, rg, grep, find, wc, pwd, echo, git status/diff/log/show/branch) without redirects, pipes, or substitution")
    }
    return
  }
  if (!isPlanWritePathAllowed(input.path ?? "", cwd)) {
    throw new ToolError("forbidden", "Plan mode may write only the Markdown plan file (a plan-named .md/.mdx file or one under plans/)")
  }
}

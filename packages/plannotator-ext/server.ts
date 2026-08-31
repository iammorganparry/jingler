/**
 * Node-compatible plan-review server for the Plannotator Pi extension.
 *
 * Pi loads extensions via jiti (Node.js), so we can't use Bun.serve().
 * This is a lightweight node:http server implementing just the routes the
 * plan-review UI needs. (The upstream code-review and annotation servers
 * were removed in Jingler's fork — see NOTICE.)
 */

export {
	type PlanServerResult,
	startPlanReviewServer,
} from "./server/serverPlan.ts";

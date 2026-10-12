import { BannerShell, Button } from "@jingler/ui"
import { Unplug } from "lucide-react"
import { rpc } from "./rpc-client.js"
import { setPlanDisconnected, usePlanDisconnected } from "./plan-presence.js"

/**
 * Shown in the Plan tab when a Plannotator review was interrupted by a host restart.
 * Reopen re-checks the persisted state first so a review that was settled elsewhere is not resumed.
 */
export function PlanReviewerDisconnectedCard({
  sessionId,
  chatId,
  onResume
}: {
  readonly sessionId: string
  readonly chatId: string
  readonly onResume: () => void
}) {
  if (!usePlanDisconnected(chatId)) return null
  const reopen = () => {
    void rpc.agentPlannotatorRecoveryNeeded(sessionId, chatId).then((needed) => {
      setPlanDisconnected(chatId, false)
      if (needed) onResume()
    }).catch(() => {})
  }
  return (
    <div className="flex-none p-3">
      <BannerShell
        placement="card"
        icon={<Unplug size={14} />}
        actions={[<Button key="reopen" size="sm" variant="secondary" onClick={reopen}>Reopen</Button>]}
      >
        Plan reviewer disconnected
      </BannerShell>
    </div>
  )
}

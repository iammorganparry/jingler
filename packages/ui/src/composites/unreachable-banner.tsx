import { WifiOff } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"

/**
 * The auth server couldn't be reached on boot. That is not "signed out": the app
 * stays usable locally, so this is a neutral top hairline notice with Retry (spec §5h).
 */
export function UnreachableBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <BannerShell
      placement="top"
      className="flex-none"
      icon={<WifiOff size={13} />}
      actions={[
        <Button key="retry" variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ]}
    >
      Can&apos;t reach Jingler, you can keep working locally
    </BannerShell>
  )
}

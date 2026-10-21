import { CloudOff, WifiOff } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"

/** No network: agents keep running locally, so this is a neutral top hairline notice (spec §5h). */
export function OfflineBanner() {
  return (
    <BannerShell placement="top" className="flex-none" icon={<WifiOff size={13} />}>
      Offline — agents keep running locally
    </BannerShell>
  )
}

/** A remote device dropped mid-run: the run is paused until it returns or is continued locally. */
export function DeviceOfflineBanner({ device, onContinueLocally }: { device: string; onContinueLocally: () => void }) {
  return (
    <BannerShell
      placement="lane"
      className="flex-none"
      icon={<CloudOff size={13} />}
      actions={[
        <Button key="continue" variant="secondary" size="sm" onClick={onContinueLocally}>
          Continue on this Mac…
        </Button>
      ]}
    >
      {device} went offline — the run is paused
    </BannerShell>
  )
}

/** The relay byte quota is spent; local runs are unaffected. */
export function RelayQuotaBanner({ resetsOn, onDismiss }: { resetsOn?: string; onDismiss?: () => void }) {
  return (
    <BannerShell placement="top" className="flex-none" icon={<CloudOff size={13} />} onDismiss={onDismiss}>
      Remote runs are paused — relay quota reached{resetsOn ? ` · resets ${resetsOn}` : ""}
    </BannerShell>
  )
}

import { Dialog, DialogContent, DialogTitle } from "../components/dialog.js"
import { LoginScreen, type LoginScreenProps } from "../screens/login-screen.js"

export interface SignInDialogProps extends Omit<LoginScreenProps, "embedded"> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Optional sign-in, opened from the sidebar footer. The app runs signed out;
 * signing in only unlocks the account-backed features (GitHub App routing,
 * paired devices). The host closes this once the auth flow reaches signed-in.
 */
export function SignInDialog({ open, onOpenChange, ...login }: SignInDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No dialog chrome: the glowing auth card IS the surface, centred on the
          blurred app. Escape and a click on the backdrop dismiss it. */}
      <DialogContent
        hideClose
        className="w-auto rounded-none border-0 bg-transparent p-16 shadow-none"
        aria-describedby={undefined}
      >
        {/* The card's own heading is the visible title; Radix still needs one it owns. */}
        <DialogTitle className="sr-only">Account</DialogTitle>
        <LoginScreen {...login} embedded />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The phone's Account as a full-screen sheet, for the Servers screen: it
 * stands before the router (and Settings) exist, so it brings its own frame.
 */
import { OverlayHeader, AppOverlay, OVERLAY_MAX_WIDTH } from '@/components/ui/app-overlay'
import { PhoneAccountContent } from '@/components/settings/pages/settings.account.phone'
import { FEATURE_NAME } from '@/components/settings/pages/account-copy'
import { Callout } from '@/components/ui/callout'

export function AccountSheet({ open, onClose, note }: {
  open: boolean
  onClose: () => void
  /** Why the sheet opened, shown above the account (a computer waiting to be added). */
  note?: string | null
}) {
  return (
    <AppOverlay open={open} onClose={onClose} label={FEATURE_NAME} maxWidth={OVERLAY_MAX_WIDTH.narrow} appLevel>
      <OverlayHeader title={FEATURE_NAME} onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-safe">
        {note && <Callout tone="info" role="status">{note}</Callout>}
        <PhoneAccountContent />
      </div>
    </AppOverlay>
  )
}

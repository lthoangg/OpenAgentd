/**
 * The phone's Account as a full-screen sheet, for the Servers screen: it
 * stands before the router (and Settings) exist, so it brings its own frame.
 */
import { OverlayHeader, AppOverlay, OVERLAY_MAX_WIDTH } from '@/components/ui/app-overlay'
import { PhoneAccountContent } from '@/components/settings/pages/settings.account.phone'

export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AppOverlay open={open} onClose={onClose} label="Account" maxWidth={OVERLAY_MAX_WIDTH.narrow} appLevel>
      <OverlayHeader title="Account" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <PhoneAccountContent />
      </div>
    </AppOverlay>
  )
}

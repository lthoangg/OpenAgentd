/**
 * AppBackendDialog — the Server panel in an overlay, for places that need it
 * outside Settings: the loading screen (no server yet), the footer health
 * dot, and a scanned `openagentd://connect` link. Settings → Server renders
 * the same `AppBackendPanel` as a page. One close button, in the header.
 */
import { Server } from 'lucide-react'
import { AppOverlay, OverlayHeader } from '@/components/ui/app-overlay'
import { OVERLAY_BODY } from '@/components/ui/panel-tokens'
import { AppBackendPanel, type AppBackendPrefill } from '@/components/AppBackendPanel'

export type { AppBackendPrefill }

interface AppBackendDialogProps {
  /** Whether the connection dialog is visible. */
  open: boolean
  /** Called when the dialog should open or close. */
  onOpenChange: (open: boolean) => void
  /** Fill the form and test it; the user still confirms with Save and use. */
  prefill?: AppBackendPrefill | null
}

export function AppBackendDialog({ open, onOpenChange, prefill = null }: AppBackendDialogProps) {
  // Always mounted: AppOverlay owns the enter and exit, so closing fades out
  // like every other overlay instead of snapping shut.
  return (
    <AppOverlay open={open} onClose={() => onOpenChange(false)} label="Server" maxWidth="640px">
      <OverlayHeader
        title="Server"
        icon={<Server size={14} />}
        onClose={() => onOpenChange(false)}
      />

      <div className={OVERLAY_BODY}>
        <AppBackendPanel active={open} prefill={prefill} showNetworkAccess />
      </div>
    </AppOverlay>
  )
}

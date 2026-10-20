/**
 * AppBackendDialog — the backend connection panel in an overlay, for places
 * that need it outside Settings: the loading screen (no backend yet), the
 * footer health dot, and a scanned `openagentd://connect` link. Settings →
 * Connection renders the same `AppBackendPanel` as a page.
 */
import { Server } from 'lucide-react'
import { AppOverlay, OverlayHeader } from '@/components/ui/app-overlay'
import { Button } from '@/components/ui/button'
import { OVERLAY_BODY } from '@/components/ui/panel-tokens'
import { AppBackendPanel, type AppBackendPrefill } from '@/components/AppBackendPanel'

export type { AppBackendPrefill }

interface AppBackendDialogProps {
  /** Whether the connection dialog is visible. */
  open: boolean
  /** Called when the dialog should open or close. */
  onOpenChange: (open: boolean) => void
  /** Fill the form and test it; the user still confirms with Save & Connect. */
  prefill?: AppBackendPrefill | null
}

export function AppBackendDialog({ open, onOpenChange, prefill = null }: AppBackendDialogProps) {
  if (!open) return null

  return (
    <AppOverlay open={open} onClose={() => onOpenChange(false)} label="Backend connection" maxWidth="640px">
      <OverlayHeader
        title="Backend connection"
        icon={<Server size={14} />}
        onClose={() => onOpenChange(false)}
        closeLabel="Close backend connection"
      />

      <div className={OVERLAY_BODY}>
        <AppBackendPanel active={open} prefill={prefill} showNetworkAccess />
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-(--color-border) bg-(--bg-sidebar) px-4 py-3 select-none md:px-6">
        <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </div>
    </AppOverlay>
  )
}

/**
 * The "Switching to …" screen: from the moment a server is picked until the
 * new one is usable. It covers the whole window, like the startup screen it
 * hands over to after the reload, since the switch replaces the whole app
 * (the old server's data is already cleared). It fades in after a beat, so
 * a switch that finishes at once never flashes it.
 *
 * Back calls the switch off (`cancelBackendSwitch`): the screen goes at once
 * and the person is where they picked the server, free to pick another.
 * Escape and Android's Back do the same (the screen is the top key layer).
 * Back goes away for the last short step, once the switch has committed.
 */
import { ChevronLeft } from 'lucide-react'

import { Seal } from '@/components/brand/Logo'
import { Button } from '@/components/ui/button'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useKeyLayer } from '@/lib/keyboard/hooks'
import { cancelBackendSwitch, useBackendSwitchStore, type BackendSwitchTarget } from '@/stores/useBackendSwitchStore'

/** The screen's words: shared with the startup screen after the reload. */
export function BackendSwitchMessage({ target }: { target: BackendSwitchTarget }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <p role="status" className="text-sm font-medium text-(--color-text-muted)">
        Switching to <span className="text-(--color-text)">{target.name}</span>…
      </p>
      {target.detail && <p className="max-w-full break-all text-xs text-(--color-text-subtle)">{target.detail}</p>}
    </div>
  )
}

/**
 * Back on a switching screen: in a bar at the top left on a phone (under the
 * safe area, where a phone's Back is), under the words elsewhere.
 */
export function BackendSwitchBack({ onBack, placement }: { onBack: () => void; placement: 'bar' | 'inline' }) {
  if (placement === 'bar') {
    return (
      <div className="mobile-safe-header absolute inset-x-0 top-0 flex items-center px-2">
        <Button
          type="button"
          variant="ghost"
          size="trigger"
          onClick={onBack}
          data-backend-switch-back=""
          className="relative touch-hit h-(--phone-control) gap-0.5 bg-transparent! pl-0 font-normal text-(--color-accent)! active:opacity-50"
        >
          <ChevronLeft size={20} strokeWidth={2.25} aria-hidden="true" className="size-5" />
          Back
        </Button>
      </div>
    )
  }
  return (
    <Button type="button" variant="subtle" size="sm" onClick={onBack} data-backend-switch-back="">Back</Button>
  )
}

export function BackendSwitchScreen() {
  const target = useBackendSwitchStore((s) => s.target)
  const committing = useBackendSwitchStore((s) => s.committing)
  const isPhone = useIsPhone()
  const canGoBack = Boolean(target) && !committing
  // Escape and Android Back: the top layer while it shows. Past the commit
  // point the layer stays, so they do nothing rather than reach what is under it.
  useKeyLayer(Boolean(target), { kind: 'dialog', onClose: () => { cancelBackendSwitch() } })
  if (!target) return null
  const back = canGoBack && <BackendSwitchBack placement={isPhone ? 'bar' : 'inline'} onBack={() => { cancelBackendSwitch() }} />
  return (
    <div
      className="oa-fade-in-late mobile-safe-shell fixed inset-0 z-70 flex items-center justify-center bg-(--bg-page)"
      data-backend-switch
    >
      {isPhone && back}
      <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center">
        <div role="status" aria-live="polite" aria-label={`Switching to ${target.name}`} className="flex flex-col items-center gap-5">
          <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
          <BackendSwitchMessage target={target} />
        </div>
        {!isPhone && back}
      </div>
    </div>
  )
}

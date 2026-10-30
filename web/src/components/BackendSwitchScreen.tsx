/**
 * The "Switching to …" screen: from the moment a server is picked until the
 * new one is usable. It covers the whole window, like the startup screen it
 * hands over to after the reload, since the switch replaces the whole app
 * (the old server's data is already cleared). It fades in after a beat, so
 * a switch that finishes at once never flashes it.
 */
import { Seal } from '@/components/brand/Logo'
import { useBackendSwitchStore, type BackendSwitchTarget } from '@/stores/useBackendSwitchStore'

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

export function BackendSwitchScreen() {
  const target = useBackendSwitchStore((s) => s.target)
  if (!target) return null
  return (
    <div
      className="oa-fade-in-late mobile-safe-shell fixed inset-0 z-70 flex items-center justify-center bg-(--bg-page)"
      role="status"
      aria-live="polite"
      aria-label={`Switching to ${target.name}`}
      data-backend-switch
    >
      <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center">
        <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
        <BackendSwitchMessage target={target} />
      </div>
    </div>
  )
}

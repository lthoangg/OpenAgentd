import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { OPENAGENTD_APP_ICON } from '@/lib/brand-assets'

export function SchedulerPage() {
  const navigate = useNavigate()
  useEffect(() => { navigate({ to: '/coding', replace: true }) }, [navigate])
  return (
    <main className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <img src={OPENAGENTD_APP_ICON} width={88} height={88} alt="" aria-hidden="true" className="rounded-2xl" />
    </main>
  )
}

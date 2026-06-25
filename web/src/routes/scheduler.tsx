import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import OpenAgentdAppIcon from '@/assets/brand/openagentd-app-icon.png'

export function SchedulerPage() {
  const navigate = useNavigate()
  useEffect(() => { navigate({ to: '/cockpit', replace: true }) }, [navigate])
  return (
    <main className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <img src={OpenAgentdAppIcon} width={88} height={88} alt="" aria-hidden="true" className="rounded-2xl" />
    </main>
  )
}

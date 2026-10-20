import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Seal } from '@/components/brand/Logo'

export function SchedulerPage() {
  const navigate = useNavigate()
  useEffect(() => { navigate({ to: '/', replace: true }) }, [navigate])
  return (
    <main className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <Seal size={88} className="text-(--color-text)" />
    </main>
  )
}

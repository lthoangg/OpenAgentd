/**
 * /scheduler — kept for deep links and restored routes (``?task=<id>``).
 * The scheduler lives in the chat view now: ask it to open, on the linked
 * task, and hand the URL back to the app.
 */
import { useEffect } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Seal } from '@/components/brand/Logo'
import { useUIStore } from '@/stores/useUIStore'

export function SchedulerPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { task?: unknown }
  const task = typeof search.task === 'string' && search.task !== '' ? search.task : null

  useEffect(() => {
    useUIStore.getState().requestSchedulerOpen(task)
    void navigate({ to: '/', replace: true })
  }, [task, navigate])

  return (
    <main className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <Seal size={88} className="text-(--color-text)" />
    </main>
  )
}

/**
 * /settings and /settings/<section> — deep links into Settings, which is a
 * modal: open it (on the section when it names one) and hand the URL back
 * to the workspace. Without this route "settings" read as a session id and
 * the window sat on "Opening session…".
 */
import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Seal } from '@/components/brand/Logo'
import { SETTINGS_SECTIONS } from '@/components/settings/sections'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'

function sectionFrom(value: unknown): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.id === value)?.id
}

export function SettingsPage() {
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { section?: unknown }
  const section = sectionFrom(params.section)

  useEffect(() => {
    useSettingsStore.getState().openSettings(section)
    void navigate({ to: '/', replace: true })
  }, [section, navigate])

  return (
    <main className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <Seal size={88} className="text-(--color-text)" />
    </main>
  )
}

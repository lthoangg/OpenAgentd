/**
 * TerminalSettingsPage — Settings → Terminal font override.
 *
 * Browsers/webviews don't expose the OS's installed font list (a
 * fingerprinting vector), so there's no way to auto-detect "the user has
 * MesloLGS NF installed" the way a native terminal app could. Instead:
 * the user types the exact font name they have, we verify it resolves in
 * this browser/webview via the Font Loading API (`isFontAvailable`), and
 * saving pushes the new stack to every live terminal immediately via
 * `useTerminalStore.syncFont` — no restart, no reconnect needed.
 */
import { useEffect, useState } from 'react'
import { TerminalSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsField } from '@/components/settings/SettingsField'
import { SettingsSection } from '@/components/settings/SettingsSection'
import {
  isFontAvailable,
  readStoredTerminalFont,
  setStoredTerminalFont,
} from '@/lib/terminal-font'
import { useTerminalStore } from '@/stores/useTerminalStore'

export function TerminalSettingsPage() {
  const [draft, setDraft] = useState(() => readStoredTerminalFont() ?? '')
  const [saved, setSaved] = useState(false)
  const trimmed = draft.trim()

  // Reset the "Saved" confirmation whenever the user edits again.
  useEffect(() => {
    setSaved(false)
  }, [draft])

  const availability = trimmed ? isFontAvailable(trimmed) : null

  const handleSave = () => {
    const next = trimmed || null
    setStoredTerminalFont(next)
    useTerminalStore.getState().syncFont(next)
    setSaved(true)
  }

  return (
    <>
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-4 select-none">
        <TerminalSquare size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-xs font-semibold text-(--color-text)">Terminal</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            OpenAgentd's terminal ships with a best-guess Nerd Font stack
            (MesloLGS NF and a few others) so prompt themes like
            Powerlevel10k render their icons and separators correctly for
            most users out of the box. If you use a different font — or
            the guess doesn't match what's installed on this machine — type
            its exact name below.
          </p>

          <SettingsSection title="Font">
            <div className="space-y-3">
              <SettingsField
                label="Terminal font name"
                hint="Exact font family name as installed on this machine, e.g. &quot;MesloLGS NF&quot; or &quot;Hack Nerd Font&quot;. Leave blank to use the built-in guess stack."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="MesloLGS NF"
                    aria-label="Terminal font name"
                    className="min-h-11 max-w-xs font-mono md:min-h-9"
                  />
                  {trimmed && availability !== null && (
                    <span
                      className={
                        availability
                          ? 'rounded border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-[10px] font-medium text-(--color-text)'
                          : 'rounded border border-(--color-error)/40 bg-(--color-error-subtle) px-1.5 py-0.5 text-[10px] font-medium text-(--color-error)'
                      }
                    >
                      {availability ? 'Available' : 'Not found on this device'}
                    </span>
                  )}
                </div>
              </SettingsField>

              <div className="flex items-center gap-3">
                <Button type="button" size="sm" onClick={handleSave} className="min-h-11 md:min-h-0">
                  Save
                </Button>
                {saved && (
                  <p className="text-xs text-(--color-text-subtle)" role="status">
                    Saved — applied to every open terminal.
                  </p>
                )}
              </div>
            </div>
          </SettingsSection>
        </div>
      </div>
    </>
  )
}

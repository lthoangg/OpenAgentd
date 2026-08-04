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
import { useState } from 'react'
import { TerminalSquare } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { SettingsField } from '@/components/settings/SettingsField'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  isFontAvailable,
  readStoredTerminalFont,
  readStoredTerminalFontSize,
  setStoredTerminalFont,
  setStoredTerminalFontSize,
} from '@/lib/terminal-font'
import { useTerminalStore } from '@/stores/useTerminalStore'

interface TerminalForm {
  font: string
  fontSize: number
}

export function TerminalSettingsPage() {
  // localStorage is the source of truth; the snapshot changes only when we
  // write it back on save.
  const [stored, setStored] = useState<TerminalForm>(() => ({
    font: readStoredTerminalFont() ?? '',
    fontSize: readStoredTerminalFontSize(),
  }))

  const draft = useSettingsDraft<TerminalForm>({
    data: stored,
    initial: stored,
    normalize: (value) => ({
      font: value.font.trim(),
      fontSize: Math.max(
        MIN_TERMINAL_FONT_SIZE,
        Math.min(value.fontSize, MAX_TERMINAL_FONT_SIZE),
      ),
    }),
    onSave: async (value) => {
      const nextFont = value.font || null
      setStoredTerminalFont(nextFont)
      useTerminalStore.getState().syncFont(nextFont)

      setStoredTerminalFontSize(value.fontSize)
      useTerminalStore.getState().syncFontSize(value.fontSize)

      setStored(value)
      return value
    },
    successTitle: 'Terminal settings saved',
  })

  const trimmed = draft.value.font.trim()
  const availability = trimmed ? isFontAvailable(trimmed) : null

  return (
    <SettingsPage
      title="Terminal"
      icon={TerminalSquare}
      draft={draft}
      intro="OpenAgentd's terminal ships with a best-guess Nerd Font stack (MesloLGS NF and a few others) so prompt themes like Powerlevel10k render their icons and separators correctly out of the box. If you use a different font, or the guess does not match what is installed on this machine, type its exact name below."
    >
      <SettingsSection title="Font">
        <div className="space-y-3">
          <SettingsField
            label="Terminal font name"
            hint="Exact font family name as installed on this machine, e.g. &quot;MesloLGS NF&quot; or &quot;Hack Nerd Font&quot;. Leave blank to use the built-in guess stack."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="text"
                value={draft.value.font}
                onChange={(e) => draft.patch({ font: e.target.value })}
                placeholder="MesloLGS NF"
                aria-label="Terminal font name"
                className="min-h-11 max-w-xs font-mono md:min-h-9"
              />
              {trimmed && availability !== null && (
                <span
                  className={
                    availability
                      ? 'rounded border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-[11px] font-medium text-(--color-text)'
                      : 'rounded border border-(--color-error)/40 bg-(--color-error-subtle) px-1.5 py-0.5 text-[11px] font-medium text-(--color-error)'
                  }
                >
                  {availability ? 'Available' : 'Not found on this device'}
                </span>
              )}
            </div>
          </SettingsField>

          <SettingsField
            label="Font size (px)"
            hint="Terminal text size in pixels (default 13px, range 9-24px)."
          >
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={MIN_TERMINAL_FONT_SIZE}
                max={MAX_TERMINAL_FONT_SIZE}
                value={draft.value.fontSize}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10)
                  if (!Number.isNaN(val)) {
                    draft.patch({
                      fontSize: Math.max(
                        MIN_TERMINAL_FONT_SIZE,
                        Math.min(val, MAX_TERMINAL_FONT_SIZE),
                      ),
                    })
                  }
                }}
                aria-label="Terminal font size"
                className="min-h-11 max-w-24 font-mono md:min-h-9"
              />
              <span className="text-xs text-(--color-text-muted)">px</span>
              <button
                type="button"
                onClick={() => draft.patch({ fontSize: DEFAULT_TERMINAL_FONT_SIZE })}
                className="min-h-11 text-xs text-(--color-accent) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:min-h-0"
              >
                Reset default ({DEFAULT_TERMINAL_FONT_SIZE}px)
              </button>
            </div>
          </SettingsField>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}

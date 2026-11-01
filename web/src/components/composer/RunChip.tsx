/**
 * RunChip — the run deck's "how this message runs" control:
 * ``provider:model · Thinking · Account``, and the run picker it opens.
 *
 * The model always reads as ``provider:model`` in mono. When the composer
 * narrows the ``provider:`` part gives way first; under 520px the chip
 * stacks into two lines (model, then level and account). Desktop and tablet
 * open the picker as a popover over the chip, phones as a bottom sheet.
 */
import { ChevronDown } from 'lucide-react'

import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { splitModelId, thinkingLevelLabel } from '@/lib/run-settings'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/useUIStore'
import { RunPicker } from './RunPicker'
import type { RunSettings } from './useRunSettings'

export function RunChip({ settings, disabled = false }: { settings: RunSettings; disabled?: boolean }) {
  const isMobile = useIsMobile()
  const { os } = usePlatform()
  const open = useUIStore((s) => s.runPickerOpen)
  const focus = useUIStore((s) => s.runPickerFocus)
  const setOpen = (next: boolean) => {
    const ui = useUIStore.getState()
    if (next) ui.openRunPicker('model')
    else ui.closeRunPicker()
  }

  const { provider, model } = settings.model ? splitModelId(settings.model) : { provider: '', model: 'No model' }
  const level = settings.thinkingLevel ? thinkingLevelLabel(settings.thinkingLevel) : null
  const account = settings.pinnedAccount?.label ?? null
  const meta = [level, account].filter(Boolean).join(' · ')
  const shortcut = shortcutLabel(APP_SHORTCUTS.sessionSettings, os)
  const label = [
    `Model ${settings.model ?? 'not set'}`,
    level ? `thinking ${level}` : null,
    account ? `account ${account}` : settings.accounts ? 'account Auto' : null,
  ].filter(Boolean).join(', ')

  const chip = (
    <button
      type="button"
      disabled={disabled}
      // The picker is the detail view, so the chip carries no tooltip; its
      // name says what runs and how to change it.
      aria-label={isMobile ? `${label}. Change` : `${label}. Change (${shortcut})`}
      aria-haspopup="dialog"
      data-run-chip=""
      onClick={isMobile ? () => setOpen(!open) : undefined}
      className={cn(
        'flex h-8 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs text-(--color-text-2) transition-colors duration-(--motion-instant)',
        'hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:cursor-not-allowed disabled:opacity-50',
        'md:h-7 pointer-coarse:h-9',
        // Stacked: two lines in a 36px chip, capped so Send keeps its room.
        '@max-[520px]:h-9 @max-[520px]:max-w-[11rem] @max-[520px]:pr-1.5',
      )}
    >
      <span className="flex min-w-0 items-baseline gap-1.5 leading-tight @max-[520px]:flex-col @max-[520px]:items-start @max-[520px]:gap-0">
        <span className="flex min-w-0 max-w-full font-mono">
          {/* The provider part gives way first, down to its "…"; the model
              part only truncates after that (see ui/model-name). */}
          {provider && <span className="min-w-[1ch] shrink truncate text-(--color-text-muted)">{provider}:</span>}
          <span className="max-w-full shrink-0 truncate">{model}</span>
        </span>
        {meta && (
          <span className="max-w-full shrink-0 truncate whitespace-nowrap text-(--color-text-muted) @max-[520px]:text-meta">
            <span aria-hidden="true" className="mr-1.5 @max-[520px]:hidden">·</span>
            {meta}
          </span>
        )}
      </span>
      <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
    </button>
  )

  if (isMobile) {
    return (
      <>
        {chip}
        <BottomSheet open={open} onClose={() => setOpen(false)} label="Model and thinking">
          <div className="px-3 pb-3">
            <RunPicker settings={settings} focus={focus} onDone={() => setOpen(false)} touch />
          </div>
        </BottomSheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={chip} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        role="dialog"
        aria-label="Model and thinking"
        className="w-[min(24rem,calc(100vw-1rem))] gap-0 p-1.5"
      >
        <RunPicker settings={settings} focus={focus} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

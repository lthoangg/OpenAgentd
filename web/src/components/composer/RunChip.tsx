/**
 * RunChip — the run deck's "how this message runs" control:
 * ``provider:model · Thinking · Account``, and the run picker it opens.
 *
 * The model always reads as ``provider:model`` in mono. When the composer
 * narrows the ``provider:`` part gives way first; under 520px the chip
 * stacks into two lines (model, then level and account). Desktop and tablet
 * open the picker as a popover over the chip, phones as a bottom sheet.
 */
import { useLayoutEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'

import { BottomSheet } from '@/components/ui/bottom-sheet'
import type { SheetDetent } from '@/components/ui/_sheet'
import { MODEL_LINE_CLASS, ModelPart, PROVIDER_PART_CLASS, splitModelTail } from '@/components/ui/model-name'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { lazySurface } from '@/lib/lazy-surface'
import { splitModelId, thinkingLevelLabel, thinkingLevelShortLabel } from '@/lib/run-settings'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/useUIStore'
import type { RunSettings } from './useRunSettings'

// The picker (search, model lists, accounts) is not on the first screen: it
// loads while the app is idle after it starts, or on first open.
const RunPicker = lazySurface(() => import('./RunPicker'), 'RunPicker')

/** The phone sheet opens at medium and pulls up to large; a shorter picker just fits its content. */
const SHEET_DETENTS: SheetDetent[] = ['medium', 'large']

/** The message box of the composer the chip sits in. */
function composerInput(): HTMLElement | null {
  let el = document.querySelector('[data-run-chip]')?.parentElement ?? null
  while (el) {
    const input = el.querySelector<HTMLElement>('textarea[aria-label="Message input"]')
    if (input) return input
    el = el.parentElement
  }
  return null
}

export function RunChip({ settings, disabled = false }: { settings: RunSettings; disabled?: boolean }) {
  const isMobile = useIsMobile()
  // A phone's deck has room for the model's name only: its distinguishing end
  // (``sonnet-4-6``), at 15px, truncating last. The picker and the label have
  // the whole ID.
  const isPhone = useIsPhone()
  const { os } = usePlatform()
  const open = useUIStore((s) => s.runPickerOpen)
  const focus = useUIStore((s) => s.runPickerFocus)
  // Focus goes back where it was when the picker opened: the message box
  // after ⌘. (so Tab switches Code/Plan again), the chip when the keyboard
  // reached it first. Opened by a click (focus on the page), the message box.
  const returnTo = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement
    returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null
  }, [open])
  const returnFocus = () => {
    const target = returnTo.current
    returnTo.current = null
    if (target?.isConnected && !target.closest('[data-run-picker]')) return target
    return composerInput()
  }
  const setOpen = (next: boolean) => {
    const ui = useUIStore.getState()
    if (next) ui.openRunPicker('model')
    else ui.closeRunPicker()
  }

  const { provider, model } = settings.model ? splitModelId(settings.model) : { provider: '', model: 'No model' }
  const level = settings.thinkingLevel ? thinkingLevelLabel(settings.thinkingLevel) : null
  // With several accounts the chip always names the one in use.
  const account = settings.inUseAccount?.label ?? null
  // The chip is narrow on a phone: it shows the short level name; its label says it whole.
  const meta = [settings.thinkingLevel ? thinkingLevelShortLabel(settings.thinkingLevel) : null, account].filter(Boolean).join(' · ')
  const shortcut = shortcutLabel(APP_SHORTCUTS.sessionSettings, os)
  const label = [
    `Model ${settings.model ?? 'not set'}`,
    level ? `thinking ${level}` : null,
    account ? `account ${account}` : null,
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
        'relative touch-hit flex h-8 min-w-0 shrink items-center gap-1.5 rounded-sm px-2 text-xs text-(--color-text-2) transition-colors duration-(--motion-instant)',
        'hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:cursor-not-allowed disabled:opacity-50',
        'md:h-7 pointer-coarse:h-9',
        // Stacked: two lines in a 36px chip, capped so Send keeps its room.
        '@max-[520px]:h-9 @max-[520px]:max-w-[11rem] @max-[520px]:pr-1.5',
        // A 320px phone (Display Zoom) leaves the chip ~50px: it drops the
        // chevron and some padding so the name keeps a few letters.
        'phone:text-meta phone:@max-[300px]:px-1.5',
      )}
    >
      <span className="flex min-w-0 items-baseline gap-1.5 leading-tight @max-[520px]:flex-col @max-[520px]:items-start @max-[520px]:gap-0">
        {isPhone ? (
          <span data-run-chip-model="" className="min-w-0 max-w-full truncate font-mono">{splitModelTail(model).tail || model}</span>
        ) : (
          <span className={cn('flex', MODEL_LINE_CLASS)}>
            {/* The provider part gives way first, whole; the model part only
                truncates after that (see ui/model-name). */}
            {provider && <span className={cn(PROVIDER_PART_CLASS, 'text-(--color-text-muted)')}>{provider}:</span>}
            <ModelPart model={model} />
          </span>
        )}
        {meta && (
          <span className="max-w-full shrink-0 truncate whitespace-nowrap text-(--color-text-muted) @max-[520px]:text-meta">
            <span aria-hidden="true" className="mr-1.5 @max-[520px]:hidden">·</span>
            {meta}
          </span>
        )}
      </span>
      <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-(--color-text-muted) phone:@max-[300px]:hidden" />
    </button>
  )

  if (isMobile) {
    return (
      <>
        {chip}
        <BottomSheet open={open} onClose={() => setOpen(false)} label="Model and thinking" detents={SHEET_DETENTS}>
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
        // Wide enough for a long `provider:model` beside "default" and its check.
        className="w-[min(28rem,calc(100vw-1rem))] gap-0 p-1.5"
        returnFocus={returnFocus}
      >
        <RunPicker settings={settings} focus={focus} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

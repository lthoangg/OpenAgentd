/**
 * SaveBar — the one way a Settings form is saved.
 *
 * A sticky bar that appears only while the draft is dirty: "Unsaved changes"
 * (or why Save is blocked), Discard…, and Save. Settings pages get it from
 * `SettingsPage`; the agent, skill and MCP editors render it under their
 * form. Only switches apply at once; everything typed into a
 * form waits for this bar.
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { RotateCcw, Save } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TEXT } from '@/components/settings/tokens'
import type { DraftControls } from '@/components/settings/useSettingsDraft'
import { settingsRoot } from '@/components/settings/settings-root'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { getPlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, chordOf, shortcutLabel } from '@/lib/app-shortcuts'
import { useShortcut } from '@/lib/keyboard/hooks'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { cn } from '@/lib/utils'

export interface SaveBarProps {
  draft: DraftControls
  onSave: () => void
  /** Why Save is disabled while the draft is dirty, shown in place of "Unsaved changes". */
  saveBlockedReason?: string | null
  /** Save button text; "Create skill" on a new item. */
  saveLabel?: string
  /** What Discard… goes back to, in its confirmation. */
  discardDescription?: string
  /**
   * Bind ⌘S / Ctrl+S inside Settings. `SettingsPage` binds it itself (it also
   * asks before a destructive save), so only the editors turn this on.
   */
  shortcut?: boolean
}

/** Save-bar enter/exit. Module scope so framer sees a stable target
 *  reference. Reduced motion fades instead of sliding: the global CSS guard in
 *  index.css only covers CSS transitions, not framer's JS-driven transforms. */
const SAVE_BAR_MOTION = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%' },
} as const
const SAVE_BAR_MOTION_REDUCED = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const

export function SaveBar({
  draft,
  onSave,
  saveBlockedReason,
  saveLabel = 'Save',
  discardDescription = 'The edits on this page go back to the last saved values.',
  shortcut = false,
}: SaveBarProps) {
  const prefersReducedMotion = useReducedMotion()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const blocked = !draft.canSave && !draft.isSaving ? saveBlockedReason : null
  const slide = prefersReducedMotion ? SAVE_BAR_MOTION_REDUCED : SAVE_BAR_MOTION
  const keys = shortcutLabel(APP_SHORTCUTS.save, getPlatform().os)

  // ⌘S / Ctrl+S saves without hunting for the button.
  useShortcut(shortcut ? chordOf(APP_SHORTCUTS.save) : null, () => {
    if (!draft.dirty || !draft.canSave) return false
    onSave()
  }, { within: settingsRoot })

  return (
    <AnimatePresence>
      {draft.dirty && (
        <motion.div
          initial={slide.initial}
          animate={slide.animate}
          exit={slide.exit}
          transition={{ duration: prefersReducedMotion ? 0 : DURATIONS_S.fast, ease: EASINGS.out }}
          className={cn(
            'sticky bottom-0 z-20 flex shrink-0 items-center gap-3',
            'border-t border-(--color-border-subtle) bg-(--bg-sidebar) px-4 py-2.5 md:px-8',
          )}
          role="region"
          aria-label="Unsaved changes"
        >
          <span className={cn('flex-1', TEXT.hint, blocked && 'text-(--color-error)')} aria-live="polite">
            {blocked || 'Unsaved changes'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-9 md:min-h-0"
            onClick={() => setConfirmDiscard(true)}
            disabled={draft.isSaving}
          >
            <RotateCcw size={12} aria-hidden="true" />
            Discard…
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="primary"
                  className="min-h-9 md:min-h-0"
                  onClick={onSave}
                  disabled={!draft.canSave}
                >
                  <Save size={12} aria-hidden="true" />
                  {draft.isSaving ? 'Saving…' : saveLabel}
                </Button>
              }
            />
            <TooltipContent>{`${saveLabel} (${keys})`}</TooltipContent>
          </Tooltip>
          <ConfirmDialog
            open={confirmDiscard}
            onOpenChange={setConfirmDiscard}
            title="Discard your changes?"
            description={discardDescription}
            confirmLabel="Discard changes"
            onConfirm={draft.reset}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

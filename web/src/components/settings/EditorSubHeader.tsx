/**
 * EditorSubHeader — sticky top bar for the agent / skill editor pane.
 *
 * Layout (left → right):
 *
 *   ◀ Back │ <kind icon> <name>          [Form/Raw]  ● Unsaved   [Save]
 *                       <path>
 *
 * The Form/Raw toggle is optional; the skill editor (which has only a raw
 * mode) hides it by passing ``mode={undefined}``.
 */
import { ArrowLeft, Save } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { useUnsavedSettings } from '@/hooks/useUnsavedSettings'

interface EditorSubHeaderProps {
  /** What the user sees: agent / skill / server name, or "New agent". */
  name: string
  /** On-disk path for the source file (shown small under the name). */
  path?: string
  /** Used for the icon in the title block. */
  kind: 'agent' | 'skill' | 'mcp'
  /** Whether the editor's working copy differs from the persisted one. */
  dirty: boolean
  /** Whether the working copy has zod validation errors. */
  invalid: boolean
  /** Whether a save mutation is currently in flight. */
  saving: boolean
  /** Latest save / create error message — surfaced inline. */
  error?: string | null
  /** First validation error message (when ``invalid``) — shown as a hint. */
  validationHint?: string | null
  /** Form/Raw toggle. Hide by leaving both ``mode`` and ``onModeChange`` unset. */
  mode?: 'form' | 'raw'
  onModeChange?: (next: 'form' | 'raw') => void
  /** Optional reason to disable saving even when the draft is dirty and valid. */
  saveDisabledReason?: string | null
  /** Save handler; the button manages its own disabled state. */
  onSave: () => void
  /** Label of the save button ("Create skill" on a new item). */
  saveLabel?: string
  /** Called when the back arrow is clicked. */
  onBack: () => void
}

export function EditorSubHeader({
  name,
  path,
  kind,
  dirty,
  invalid,
  saving,
  error,
  validationHint,
  saveDisabledReason,
  mode,
  onModeChange,
  onSave,
  onBack,
  saveLabel = 'Save',
}: EditorSubHeaderProps) {
  useUnsavedSettings(dirty || saving)
  const showToggle = mode != null && onModeChange != null

  // Save is disabled when there is nothing to save, when the draft is
  // invalid, or when a save is already in flight.
  const saveDisabled = Boolean(saveDisabledReason) || !dirty || invalid || saving
  const saveTooltip = saveDisabledReason
    ? saveDisabledReason
    : invalid
      ? (validationHint ?? 'Fix validation errors')
      : !dirty
        ? 'No unsaved changes'
        : 'Save (⌘S)'

  return (
    <div className="sticky top-0 z-10 shrink-0 border-b border-(--color-border) bg-(--bg-page)" data-editor-kind={kind}>
    {/* Phones: the switch drops to a second row and Save to its icon, so
        the name and path keep the width instead of a few characters. */}
    <header className="flex min-h-14 items-center gap-2 px-2 max-sm:flex-wrap max-sm:py-2 sm:h-14 sm:gap-3 sm:px-4 md:px-6">
      {/* Title block ─────────────────────────────────────────────── */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className="md:size-7"
              onClick={onBack}
              aria-label="Back to list"
            >
              <ArrowLeft size={14} />
            </Button>
          }
        />
        <TooltipContent>Back</TooltipContent>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight text-(--color-text)">{name}</p>
        {path && (
          <p className="truncate font-mono text-xs md:text-[11px] text-(--color-text-muted)">
            {path}
          </p>
        )}
      </div>

      {/* Form / Raw toggle ──────────────────────────────────────── */}
      {showToggle && (
        <div data-editor-mode="" className="max-sm:order-last max-sm:w-full">
        <Tabs value={mode} onValueChange={(v) => onModeChange(v as 'form' | 'raw')}>
          <TabsList className="h-7 max-sm:w-full">
            <TabsTrigger value="form" className="px-2 text-xs max-sm:flex-1">
              Form
            </TabsTrigger>
            <TabsTrigger value="raw" className="px-2 text-xs max-sm:flex-1">
              Source
            </TabsTrigger>
          </TabsList>
        </Tabs>
        </div>
      )}

      {/* Status + Save ──────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {!error && !invalid && dirty && (
          <span className="hidden items-center gap-1.5 text-xs text-(--color-text-muted) sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-(--color-text)" aria-hidden="true" />
            Unsaved
          </span>
        )}

        {saveTooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  className="min-h-9 md:min-h-0"
                  onClick={onSave}
                  disabled={saveDisabled}
                  aria-label={saving ? 'Saving' : saveLabel}
                >
                  <Save size={12} aria-hidden="true" />
                  <span className="max-sm:sr-only">{saving ? 'Saving…' : saveLabel}</span>
                </Button>
              }
            />
            <TooltipContent>{saveTooltip}</TooltipContent>
          </Tooltip>
        ) : (
          <Button size="sm" className="min-h-9 md:min-h-0" onClick={onSave} disabled={saveDisabled} aria-label={saving ? 'Saving' : saveLabel}>
            <Save size={12} aria-hidden="true" />
            <span className="max-sm:sr-only">{saving ? 'Saving…' : saveLabel}</span>
          </Button>
        )}
      </div>
    </header>
    {(error || (invalid && validationHint)) && (
      <div className="px-2 pb-2 sm:px-4 md:px-6">
        <Callout tone="error" role="alert" title={error ? "Couldn't save" : 'Fix this to save'}>
          {error ?? validationHint}
        </Callout>
      </div>
    )}
    </div>
  )
}

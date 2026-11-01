/**
 * NativeSelect — a single-choice control that hands the choice to the phone's
 * own picker (iOS action sheet, Android single-choice dialog) and renders
 * the caller's regular select everywhere else.
 *
 *   <NativeSelect
 *     title="Theme"
 *     value={theme}
 *     onValueChange={setTheme}
 *     options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
 *     fallback={<Dropdown value={theme} onValueChange={setTheme} … />}
 *   />
 *
 * For a handful of simple values. The ``fallback`` is shown outside the
 * mobile shell, and in place of the button when the native picker turns out
 * not to be available (``pickNative`` resolves ``undefined``), so a failing
 * shell never leaves a control that does nothing.
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/use-platform'
import { pickNative } from '@/lib/native-picker'
import { buttonVariants } from '@/components/ui/button'

export interface NativeSelectOption {
  value: string
  label: string
}

export interface NativeSelectProps {
  value: string
  onValueChange: (value: string) => void
  options: readonly NativeSelectOption[]
  /** Heading of the native sheet, and the control's accessible name unless ``aria-label`` is given. */
  title: string
  'aria-label'?: string
  /** Shown when ``value`` matches no option. */
  placeholder?: string
  id?: string
  disabled?: boolean
  className?: string
  /** The app's own select, rendered whenever the native picker is not used. */
  fallback: ReactNode
}

export function NativeSelect({
  value,
  onValueChange,
  options,
  title,
  'aria-label': ariaLabel,
  placeholder = '',
  id,
  disabled,
  className,
  fallback,
}: NativeSelectProps) {
  const { isTauri, os } = usePlatform()
  const [unavailable, setUnavailable] = useState(false)
  const [opening, setOpening] = useState(false)

  if (!isTauri || (os !== 'ios' && os !== 'android') || unavailable) return <>{fallback}</>

  const current = options.find((o) => o.value === value)
  const currentLabel = current?.label ?? placeholder
  // The visible text is the value, so the name carries both: a label alone
  // would hide the current choice from a screen reader.
  const name = ariaLabel ?? title

  async function open() {
    if (opening) return
    setOpening(true)
    try {
      const picked = await pickNative(
        title,
        options.map((o) => ({ id: o.value, label: o.label })),
        current?.value,
      )
      if (picked === undefined) setUnavailable(true)
      else if (picked !== null && picked !== value) onValueChange(picked)
    } finally {
      setOpening(false)
    }
  }

  return (
    <button
      id={id}
      type="button"
      disabled={disabled}
      aria-label={currentLabel ? `${name}: ${currentLabel}` : name}
      aria-haspopup="listbox"
      onClick={() => void open()}
      className={cn(
        buttonVariants({ variant: 'default', size: 'trigger' }),
        'justify-between pointer-coarse:min-h-9',
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{currentLabel}</span>
      <ChevronDown size={11} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
    </button>
  )
}

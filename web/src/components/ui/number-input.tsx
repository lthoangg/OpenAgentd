import { createContext, useContext, useMemo, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

interface NumberInputContextValue {
  value: number | null
  setValue: (value: number | null) => void
  min?: number
  max?: number
  step: number
  disabled?: boolean
}

const NumberInputContext = createContext<NumberInputContextValue | null>(null)

function useNumberInputContext() {
  const context = useContext(NumberInputContext)
  if (!context) throw new Error('NumberInput components must be used inside <NumberInput>')
  return context
}

interface NumberInputProps extends Omit<ComponentPropsWithRef<'div'>, 'defaultValue' | 'onChange'> {
  /** Controlled numeric value. */
  value?: number | null
  /** Initial numeric value for uncontrolled usage. */
  defaultValue?: number | null
  /** Minimum allowed value. */
  min?: number
  /** Maximum allowed value. */
  max?: number
  /** Step used by the increment/decrement buttons. */
  step?: number
  /** Called when the numeric value changes. */
  onValueChange?: (value: number | null) => void
  /** Disable the input and steppers. */
  disabled?: boolean
  /** Composed number input controls. */
  children?: ReactNode
}

function clamp(value: number, min?: number, max?: number) {
  let next = value
  if (min !== undefined) next = Math.max(min, next)
  if (max !== undefined) next = Math.min(max, next)
  return next
}

function NumberInput({ className, value, defaultValue = null, min, max, step = 1, onValueChange, disabled, children, ...props }: NumberInputProps) {
  const [internalValue, setInternalValue] = useState<number | null>(defaultValue)
  const currentValue = value ?? internalValue
  const contextValue = useMemo<NumberInputContextValue>(() => ({
    value: currentValue,
    min,
    max,
    step,
    disabled,
    setValue: (next) => {
      const clamped = next === null ? null : clamp(next, min, max)
      if (value === undefined) setInternalValue(clamped)
      onValueChange?.(clamped)
    },
  }), [currentValue, disabled, max, min, onValueChange, step, value])

  return (
    <NumberInputContext.Provider value={contextValue}>
      <div data-slot="number-input" className={cn('w-full', className)} {...props}>
        {children}
      </div>
    </NumberInputContext.Provider>
  )
}

function NumberInputGroup({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      data-slot="number-input-group"
      className={cn(
        'flex h-9 w-full overflow-hidden rounded-md border border-(--color-border) bg-(--bg-input) text-sm text-(--color-text) transition-colors focus-within:ring-2 focus-within:ring-(--focus-ring)/30',
        className,
      )}
      {...props}
    />
  )
}

function NumberInputField({ className, onChange, onKeyDown, ...props }: Omit<ComponentPropsWithRef<'input'>, 'value' | 'defaultValue' | 'type'>) {
  const { value, setValue, disabled, min, max, step } = useNumberInputContext()
  return (
    <input
      type="text"
      inputMode="numeric"
      data-slot="number-input-field"
      value={value ?? ''}
      disabled={disabled}
      className={cn(
        'min-w-0 flex-1 bg-transparent px-3 font-mono text-sm tabular-nums outline-none placeholder:text-(--color-text-subtle) disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      onChange={(event) => {
        const raw = event.currentTarget.value.trim()
        setValue(raw === '' ? null : Number(raw))
        onChange?.(event)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setValue(clamp((value ?? min ?? 0) + step, min, max))
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setValue(clamp((value ?? min ?? 0) - step, min, max))
        }
        onKeyDown?.(event)
      }}
      {...props}
    />
  )
}

function NumberInputStepper({ className }: { className?: string }) {
  const { value, setValue, min, max, step, disabled } = useNumberInputContext()
  const base = value ?? min ?? 0
  return (
    <div data-slot="number-input-stepper" className={cn('flex w-8 shrink-0 flex-col border-l border-(--color-border)', className)}>
      <button type="button" disabled={disabled} className="flex flex-1 items-center justify-center text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-40" onClick={() => setValue(clamp(base + step, min, max))}>
        <ChevronUpIcon className="size-3" aria-hidden="true" />
      </button>
      <div className="h-px bg-(--color-border)" />
      <button type="button" disabled={disabled} className="flex flex-1 items-center justify-center text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-40" onClick={() => setValue(clamp(base - step, min, max))}>
        <ChevronDownIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}

export { NumberInput, NumberInputField, NumberInputGroup, NumberInputStepper }

import { createContext, useContext, useMemo, useState, type ComponentPropsWithRef, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface RadioGroupContextValue {
  name: string | undefined
  value: string | undefined
  setValue: (value: string) => void
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

interface RadioGroupProps extends Omit<ComponentPropsWithRef<'div'>, 'defaultValue' | 'onChange'> {
  /** Controlled selected value. */
  value?: string
  /** Initial selected value for uncontrolled usage. */
  defaultValue?: string
  /** Called when the selected value changes. */
  onValueChange?: (value: string) => void
  /** Shared radio name. */
  name?: string
  /** Radio items. */
  children?: ReactNode
}

function RadioGroup({ className, value, defaultValue, onValueChange, name, children, ...props }: RadioGroupProps) {
  const [internalValue, setInternalValue] = useState(defaultValue)
  const currentValue = value ?? internalValue
  const contextValue = useMemo<RadioGroupContextValue>(() => ({
    name,
    value: currentValue,
    setValue: (next) => {
      if (value === undefined) setInternalValue(next)
      onValueChange?.(next)
    },
  }), [currentValue, name, onValueChange, value])

  return (
    <RadioGroupContext.Provider value={contextValue}>
      <div data-slot="radio-group" role="radiogroup" className={cn('grid gap-2', className)} {...props}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

interface RadioGroupItemProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /** Radio item value. */
  value: string
}

function RadioGroupItem({ className, value, onChange, name, checked, ...props }: RadioGroupItemProps) {
  const context = useContext(RadioGroupContext)
  const isChecked = checked ?? context?.value === value

  return (
    <span className="relative inline-flex size-[18px] shrink-0">
      <input
        type="radio"
        data-slot="radio-group-item"
        name={name ?? context?.name}
        value={value}
        checked={isChecked}
        className={cn(
          'peer size-[18px] appearance-none rounded-full border border-(--color-border-strong) bg-(--bg-page) transition-colors outline-none',
          'checked:border-(--accent-blue) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25',
          'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
        onChange={(event) => {
          if (event.currentTarget.checked) context?.setValue(value)
          onChange?.(event)
        }}
        {...props}
      />
      <span className="pointer-events-none absolute inset-0 m-auto size-2 rounded-full bg-(--accent-blue) opacity-0 transition-opacity peer-checked:opacity-100" aria-hidden="true" />
    </span>
  )
}

export { RadioGroup, RadioGroupItem }

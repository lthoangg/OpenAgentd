import { createContext, useContext, useId, useMemo, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface TabsContextValue {
  id: string
  value: string | undefined
  setValue: (value: string) => void
  orientation: 'horizontal' | 'vertical'
}

const TabsContext = createContext<TabsContextValue | null>(null)

type TabsSize = 'default' | 'sm'

/** Size chosen on ``TabsList`` and read by its triggers. */
const TabsListSizeContext = createContext<TabsSize>('default')

function useTabsContext() {
  const context = useContext(TabsContext)
  if (!context) throw new Error('Tabs components must be used inside <Tabs>')
  return context
}

interface TabsProps extends Omit<ComponentPropsWithRef<'div'>, 'defaultValue' | 'onChange'> {
  /** Controlled active tab value. */
  value?: string
  /** Initial active tab value for uncontrolled usage. */
  defaultValue?: string
  /** Called when the active tab changes. */
  onValueChange?: (value: string) => void
  /** Tab axis. */
  orientation?: 'horizontal' | 'vertical'
  /** Tab children. */
  children?: ReactNode
}

function Tabs({ className, value, defaultValue, onValueChange, orientation = 'horizontal', children, ...props }: TabsProps) {
  const id = useId()
  const [internalValue, setInternalValue] = useState(defaultValue)
  const currentValue = value ?? internalValue
  const contextValue = useMemo<TabsContextValue>(() => ({
    id,
    value: currentValue,
    setValue: (next) => {
      if (value === undefined) setInternalValue(next)
      onValueChange?.(next)
    },
    orientation,
  }), [id, currentValue, onValueChange, orientation, value])

  return (
    <TabsContext.Provider value={contextValue}>
      <div
        data-slot="tabs"
        data-orientation={orientation}
        className={cn('group/tabs flex gap-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:flex-row', className)}
        {...props}
      >
        {children}
      </div>
    </TabsContext.Provider>
  )
}

const TABS_LIST_BASE = 'group/tabs-list inline-flex w-fit max-w-full items-center justify-center overflow-x-auto border border-(--color-border) bg-(--bg-key) p-0.5 text-(--color-text-muted) data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col data-[orientation=vertical]:overflow-x-visible data-[variant=line]:border-transparent data-[variant=line]:bg-transparent data-[variant=line]:p-0'
const TABS_LIST_VARIANT: Record<string, string> = { default: '', line: 'gap-1' }
// Height lives in the size map (not the base) because ``cn`` is a plain join:
// a caller's ``h-*`` cannot override a base height it does not replace.
const TABS_LIST_SIZE: Record<TabsSize, string> = {
  default: 'rounded-md data-[orientation=horizontal]:h-8',
  sm: 'rounded-sm data-[orientation=horizontal]:h-6',
}
const TABS_TRIGGER_SIZE: Record<TabsSize, string> = {
  default: 'px-3 py-1 text-sm [&_svg:not([class*=size-])]:size-4',
  sm: 'px-2 text-xs [&_svg:not([class*=size-])]:size-3',
}

function tabsListVariants({ variant = 'default', size = 'default' }: { variant?: 'default' | 'line' | null; size?: TabsSize } = {}): string {
  return cn(TABS_LIST_BASE, TABS_LIST_SIZE[size], TABS_LIST_VARIANT[variant ?? 'default'])
}

interface TabsListProps extends ComponentPropsWithRef<'div'> {
  /** Visual treatment. */
  variant?: 'default' | 'line' | null
  /** ``sm`` is the 24px segmented control for dense panel toolbars. */
  size?: TabsSize
}

function TabsList({ className, variant = 'default', size = 'default', ...props }: TabsListProps) {
  const { orientation } = useTabsContext()
  return (
    <TabsListSizeContext.Provider value={size}>
      <div
        role="tablist"
        data-slot="tabs-list"
        data-variant={variant}
        data-size={size}
        data-orientation={orientation}
        aria-orientation={orientation}
        className={cn(tabsListVariants({ variant, size }), className)}
        {...props}
      />
    </TabsListSizeContext.Provider>
  )
}

interface TabsTriggerProps extends ComponentPropsWithRef<'button'> {
  /** Tab value selected by this trigger. */
  value: string
}

function TabsTrigger({ className, value, id, type = 'button', onClick, onKeyDown, ...props }: TabsTriggerProps) {
  const { id: groupId, value: activeValue, setValue, orientation } = useTabsContext()
  const size = useContext(TabsListSizeContext)
  const active = activeValue === value
  const triggerId = id ?? `${groupId}-${encodeURIComponent(value)}-tab`

  return (
    <button
      id={triggerId}
      type={type}
      role="tab"
      data-slot="tabs-trigger"
      data-active={active ? '' : undefined}
      aria-selected={active}
      aria-controls={`${groupId}-${encodeURIComponent(value)}-panel`}
      tabIndex={active ? 0 : -1}
      className={cn(
        'relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-xs border border-transparent font-medium whitespace-nowrap text-(--color-text-muted) transition-colors',
        TABS_TRIGGER_SIZE[size],
        'hover:bg-(--bg-card)/40 hover:text-(--color-text) active:bg-(--bg-card)/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 disabled:pointer-events-none disabled:opacity-50',
        'data-active:bg-(--bg-card) data-active:text-(--color-text)',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) setValue(value)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        const previous = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
        const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
        if (![previous, next, 'Home', 'End'].includes(event.key)) return
        const list = event.currentTarget.closest('[role="tablist"]')
        const tabs = Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])
        if (!tabs.length) return
        const index = tabs.indexOf(event.currentTarget)
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + (event.key === next ? 1 : -1) + tabs.length) % tabs.length
        event.preventDefault()
        tabs[target].focus()
        tabs[target].click()
      }}
      {...props}
    />
  )
}

interface TabsContentProps extends ComponentPropsWithRef<'div'> {
  /** Tab value that reveals this panel. */
  value?: string
}

function TabsContent({ className, value, hidden, ...props }: TabsContentProps) {
  const { id, value: activeValue } = useTabsContext()
  const isHidden = value ? activeValue !== value : hidden
  return (
    <div
      id={value ? `${id}-${encodeURIComponent(value)}-panel` : undefined}
      aria-labelledby={value ? `${id}-${encodeURIComponent(value)}-tab` : undefined}
      role={value ? 'tabpanel' : undefined}
      data-slot="tabs-content"
      hidden={isHidden}
      className={cn('flex-1 text-sm text-(--color-text) outline-none', className)}
      {...props}
    />
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }

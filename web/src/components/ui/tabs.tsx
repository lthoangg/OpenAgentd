import { createContext, useContext, useId, useMemo, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface TabsContextValue {
  value: string | undefined
  setValue: (value: string) => void
  orientation: 'horizontal' | 'vertical'
}

const TabsContext = createContext<TabsContextValue | null>(null)

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
  const [internalValue, setInternalValue] = useState(defaultValue)
  const currentValue = value ?? internalValue
  const contextValue = useMemo<TabsContextValue>(() => ({
    value: currentValue,
    setValue: (next) => {
      if (value === undefined) setInternalValue(next)
      onValueChange?.(next)
    },
    orientation,
  }), [currentValue, onValueChange, orientation, value])

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

const TABS_LIST_BASE = 'group/tabs-list inline-flex w-fit max-w-full items-center justify-center overflow-x-auto rounded-md border border-(--color-border) bg-(--bg-key) p-0.5 text-(--color-text-muted) data-[orientation=horizontal]:h-8 data-[orientation=vertical]:h-fit data-[orientation=vertical]:flex-col data-[orientation=vertical]:overflow-x-visible data-[variant=line]:border-transparent data-[variant=line]:bg-transparent data-[variant=line]:p-0'
const TABS_LIST_VARIANT: Record<string, string> = { default: '', line: 'gap-1' }

function tabsListVariants({ variant = 'default' }: { variant?: 'default' | 'line' | null } = {}): string {
  return cn(TABS_LIST_BASE, TABS_LIST_VARIANT[variant ?? 'default'])
}

interface TabsListProps extends ComponentPropsWithRef<'div'> {
  /** Visual treatment. */
  variant?: 'default' | 'line' | null
}

function TabsList({ className, variant = 'default', ...props }: TabsListProps) {
  const { orientation } = useTabsContext()
  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      data-variant={variant}
      data-orientation={orientation}
      aria-orientation={orientation}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

interface TabsTriggerProps extends ComponentPropsWithRef<'button'> {
  /** Tab value selected by this trigger. */
  value: string
}

function TabsTrigger({ className, value, id, type = 'button', onClick, ...props }: TabsTriggerProps) {
  const generatedId = useId()
  const { value: activeValue, setValue } = useTabsContext()
  const active = activeValue === value
  const triggerId = id ?? `${generatedId}-tab`

  return (
    <button
      id={triggerId}
      type={type}
      role="tab"
      data-slot="tabs-trigger"
      data-active={active ? '' : undefined}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cn(
        'relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-xs border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap text-(--color-text-muted) transition-colors',
        'hover:bg-(--bg-card)/40 hover:text-(--color-text) active:bg-(--bg-card)/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30 disabled:pointer-events-none disabled:opacity-50',
        'data-active:border-(--color-border-strong) data-active:bg-(--bg-card) data-active:text-(--color-text) data-active:shadow-sm',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        className,
      )}
      onClick={(event) => {
        setValue(value)
        onClick?.(event)
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
  const { value: activeValue } = useTabsContext()
  const isHidden = value ? activeValue !== value : hidden
  return (
    <div
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

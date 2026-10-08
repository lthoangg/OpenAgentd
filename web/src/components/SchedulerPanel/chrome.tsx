/**
 * Scheduler surface chrome.
 *
 * The scheduler renders in two hosts: the full-screen / centered overlay
 * (mobile, and desktop without a workspace) and the desktop review dock's
 * Schedule tab. Pane headers sit on the overlay's rail tone, but on the page
 * tone in the dock so the active editor tab opens onto its content.
 */
import { Button } from '@/components/ui/button'
import { createContext, useContext } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type SchedulerChrome = 'overlay' | 'dock'

export const SchedulerChromeContext = createContext<SchedulerChrome>('overlay')

export function useSchedulerChrome(): SchedulerChrome {
  return useContext(SchedulerChromeContext)
}

/** Class for a detail / form pane header in the current host. */
export function useSchedulerPaneHeaderClass(): string {
  return useSchedulerChrome() === 'dock'
    ? 'border-b border-(--color-border-subtle) bg-(--bg-page) px-3 py-2'
    : 'border-b border-(--color-border) bg-(--bg-sidebar) px-4 py-2.5 @xl:px-5'
}

/** Leading back control for stacked (list → detail) hosts. */
export function SchedulerBackButton({ onClick, label = 'Back to task list' }: { onClick: () => void; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-dense" className="-ml-1" onClick={onClick} aria-label={label}>
            <ArrowLeft size={14} aria-hidden="true" />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

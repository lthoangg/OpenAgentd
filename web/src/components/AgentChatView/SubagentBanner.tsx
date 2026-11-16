/**
 * A subagent's session in place of the composer: the main agent directs
 * it, so the chat names the lead and offers the way back to its session.
 */
import { Button } from '@/components/ui/button'

export function SubagentBanner({ leadName, onOpenLead }: { leadName: string | null; onOpenLead: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-3">
      {/* Phones wrap the sentence and drop the button under it, rather
          than truncating the explanation to a few words. */}
      <div data-subagent-banner="" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-4 py-2 text-xs text-(--color-text-muted) sm:flex-nowrap">
        <div className="flex min-w-0 items-start gap-2 sm:items-center">
          <span className="shrink-0 rounded-xs bg-(--bg-key)/60 px-1.5 py-0.5 font-mono text-meta font-semibold text-(--color-text)">
            {leadName}
          </span>
          <span className="sm:truncate">The main agent directs this subagent. Open the main agent's session to send instructions.</span>
        </div>
        <Button
          size="xs"
          variant="default"
          onClick={onOpenLead}
          className="shrink-0"
        >
          Return to main agent
        </Button>
      </div>
    </div>
  )
}

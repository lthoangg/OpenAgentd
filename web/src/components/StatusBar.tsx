import { shortId, formatTokens } from '@/utils/format'
import type { AgentUsage } from '@/api/types'

interface StatusBarProps {
  sessionId: string | null
  agent?: string
  model?: string
  isStreaming?: boolean
  error?: string | null
  usage?: AgentUsage | null
}

export function StatusBar({
  sessionId,
  isStreaming,
  error,
  usage,
}: StatusBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-(--color-border) bg-(--bg-page) px-3 py-1 text-xs text-(--color-text-subtle) sm:px-4">
      {/* Left: session ID */}
      <div className="flex min-w-0 items-center gap-2">
         {sessionId && (
           <span className="font-mono text-(--color-text-subtle)">
             {shortId(sessionId)}
           </span>
         )}
         {isStreaming && (
           <span className="flex items-center gap-1 text-(--color-text-2)">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-accent)" />
             streaming
           </span>
         )}
       </div>

       {/* Center: error */}
       {error && (
         <span className="max-w-xs truncate text-(--color-error)">
           {error}
         </span>
       )}

       {/* Right: token count */}
       <div className="flex items-center gap-2">
         {usage && (
           <span
             className="flex h-7 min-w-7 items-center justify-center rounded-full border border-(--color-border) bg-(--bg-key) px-1.5 font-mono text-[10px] text-(--color-text)"
             title={`Input: ${usage.promptTokens.toLocaleString()} · Output: ${usage.completionTokens.toLocaleString()} · Cache: ${usage.cachedTokens.toLocaleString()}`}
           >
             {formatTokens(usage.promptTokens)}
           </span>
         )}
         <span className="hidden text-(--color-text-subtle) sm:inline">Ctrl+N new</span>
       </div>
     </div>
   )
}

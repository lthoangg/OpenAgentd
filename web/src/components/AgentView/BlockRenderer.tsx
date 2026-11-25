/**
 * One transcript row, by block type: a prompt (or the goal and restart
 * dividers a prompt can stand for), thinking, a tool call with its MCP app,
 * a compaction, a provider status (error card, retry line, quota wait,
 * account switch) or an answer's text.
 */
import { memo } from 'react'
import type { ContentBlock } from '@/api/types'
import { Chip } from '@/components/ui/chip'
import { ModelName } from '@/components/ui/model-name'
import { goalTurnInfo } from '@/lib/goal'
import { lazySurface } from '@/lib/lazy-surface'
import { restartNoteInfo } from '@/lib/restart-note'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { useAgentStore } from '@/stores/useAgentStore'
import { extractSleepPrefix } from '@/utils/format'
import { fromLead } from '@/utils/lead-messages'
import { MarkdownBlock } from '@/utils/markdown'
import { replyFrom, sentFrom } from '@/utils/workspace-messages'
import { commandExit } from '@/utils/command-report'
import { CompactionDivider } from '../CompactionDivider'
import { Thinking } from '../Thinking'
import { ToolCall } from '../ToolCall'
import { ErrorCard } from './ErrorCard'
import { GoalTurnDivider } from './GoalTurnDivider'
import { isBareExhausted, isProviderErrorBlock, providerErrorDetails, switchedAccount } from './provider-status'
import { QuotaWaitNotice, quotaWaitFromBlock } from './QuotaWaitNotice'
import { RestartDivider } from './RestartDivider'
import { RetryNotice } from './RetryNotice'
import { CommandReport } from './CommandReport'
import { UserBubble, type OpenSessionHandler } from './UserBubble'

// MCP app results (and the MCP SDK they need) are rare: kept out of the
// startup bundle and prefetched while the app is idle.
const MCPAppResult = lazySurface(() => import('../MCPAppResult'), 'MCPAppResult')

/** The server's error title, with its legacy Title Case default in plain words. */
function providerErrorTitle(title: unknown): string {
  if (typeof title !== 'string' || !title || title === 'Provider Error') return 'Model error'
  return title
}

export const BlockRenderer = memo(function BlockRenderer({ block, isStreaming, sessionId, leadSessionId, onEdit, editLocked, promptModel, promptThinkingLevel, onRetry, onSwitchModel, latestMCPAppBlockIds, onMentionFileOpen, onOpenSession, activeQuotaWaitBlockId, activeRetryBlockId }: {
  block: ContentBlock
  isStreaming: boolean
  sessionId?: string
  /** The open session's parent, when it is a subagent: names the lead for its untagged messages. */
  leadSessionId?: string
  /** Rewind to a prompt the user wrote; ignored for agent reports. */
  onEdit?: (blockId: string) => void
  /** A turn is running: Edit shows, disabled, until it ends. */
  editLocked?: boolean
  /** The model and thinking level a prompt ran with; strings so memo holds while streaming. */
  promptModel?: string
  promptThinkingLevel?: string
  /** Error actions; the caller passes them to the error a turn ended with only. */
  onRetry?: () => void
  onSwitchModel?: () => void
  latestMCPAppBlockIds?: Set<string>
  onMentionFileOpen?: (path: string) => void
  onOpenSession?: OpenSessionHandler
  activeQuotaWaitBlockId?: string
  /** The one retry notice still waiting; the others have resolved and hide. */
  activeRetryBlockId?: string
}) {
  switch (block.type) {
    case 'user': {
      const fromAgent = typeof block.extra?.from_agent === 'string' ? block.extra.from_agent : null
      const goalTurn = goalTurnInfo(block)
      if (goalTurn) return <GoalTurnDivider info={goalTurn} />
      const restart = restartNoteInfo(block)
      if (restart) return <RestartDivider info={restart} />
      // A background command's end report: drawn as a terminal result, not as prose.
      const exit = commandExit(block.extra)
      if (exit) return <CommandReport exit={exit} content={block.content} timestamp={block.timestamp} />
      // The lead's message to this subagent: its prefix is the chip's job, and
      // Edit would rewind the subagent, which the lead directs.
      const lead = fromAgent ? null : fromLead(block.extra, block.content, leadSessionId)
      // Another workspace's agent sent it: rewinding it is that agent's call.
      const sender = sentFrom(block.extra)
      const editable = Boolean(onEdit) && !fromAgent && !lead && !sender
      const revert = (keepFiles: boolean) => { void useAgentStore.getState().revertToMessage(block.id, { restoreDraft: false, keepFiles }) }
      // Chat never rolls files back, so its plain Undo already keeps them.
      const keepFilesUndo = editable && !isChatWorkspacePath(useAgentStore.getState()._workspace)
      return <UserBubble content={lead ? lead.content : block.content} timestamp={block.timestamp} attachments={block.attachments} onEdit={editable && onEdit ? () => onEdit(block.id) : undefined} onRevert={editable ? () => revert(false) : undefined} onRevertMessages={keepFilesUndo ? () => revert(true) : undefined} editLocked={editLocked} modelId={promptModel} thinkingLevel={promptThinkingLevel} onMentionFileOpen={onMentionFileOpen} mentions={block.extra?.mentions as string[] | undefined} fromAgent={fromAgent} sentFrom={sender} fromLeadSessionId={lead?.sessionId} replyFrom={replyFrom(block.extra)} onOpenSession={onOpenSession} />
    }
    case 'thinking':
      return <Thinking content={block.content} isStreaming={isStreaming} durationMs={block.thinkingDurationMs} />
    case 'compaction': {
      const state = block.extra?.state === 'compacting' ? 'compacting' : 'compacted'
      const error = Boolean(block.extra?.error)
      return (
        <CompactionDivider
          state={state}
          error={error}
          summary={block.content}
          sessionId={sessionId}
          isStreaming={isStreaming}
        />
      )
    }
    case 'provider_status': {
      const status = block.extra?.status
      const customMsg = block.extra?.message as string | undefined

      if (isBareExhausted(block)) {
        const model = typeof block.extra?.model === 'string' ? block.extra.model : undefined
        return (
          <RetryNotice
            exhausted
            model={model}
            maxAttempts={block.extra?.max_attempts}
            errorType={block.extra?.error_type}
            statusCode={block.extra?.status_code}
          />
        )
      }

      if (isProviderErrorBlock(block)) {
        const title = providerErrorTitle(block.extra?.title)
        const message = customMsg || block.content
        return (
          <ErrorCard
            title={title}
            message={message}
            details={providerErrorDetails({ title, message, extra: block.extra })}
            code={typeof block.extra?.code === 'string' ? block.extra.code : undefined}
            onRetry={onRetry}
            onSwitchModel={onSwitchModel}
          />
        )
      }

      if (status === 'waiting_quota' || status === 'waiting_credential') {
        if (block.id !== activeQuotaWaitBlockId) return null
        const wait = quotaWaitFromBlock(block)
        return wait ? <QuotaWaitNotice wait={wait} sessionId={sessionId} persist /> : null
      }

      const model = typeof block.extra?.model === 'string' ? block.extra.model : undefined
      if (status === 'retrying') {
        if (block.id !== activeRetryBlockId) return null
        return (
          <RetryNotice
            model={model}
            attempt={block.extra?.attempt}
            maxAttempts={block.extra?.max_attempts}
            delay={block.extra?.delay_seconds}
            errorType={block.extra?.error_type}
            statusCode={block.extra?.status_code}
          />
        )
      }
      if (status === 'switched_credential') {
        // A key or account hit its limit; the same turn continues on the next one.
        const { account, reason } = switchedAccount(block.extra)
        return (
          <div role="status" data-credential-switch className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--color-text-muted)">
            <Chip tone="info">
              {account ? <>Switched to account <span className="font-semibold">{account}</span></> : 'Switched account'}
            </Chip>
            <span className="min-w-0 break-words">
              {reason ?? (model ? <><ModelName id={model} className="align-bottom" /> continues on another account.</> : 'The model continues on another account.')}
            </span>
          </div>
        )
      }
      let message = 'Provider status updated.'
      if (status === 'pin_released') {
        // The locked account was removed or turned off: the session follows the provider's choice.
        message = customMsg || "The account this session started on is gone, so it uses the provider's next available account."
      }
      return <p className="rounded-sm border border-(--color-border-subtle) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-muted)">{message}</p>
    }
    case 'tool': {
      const mcpApp = (block.extra as { mcp_app?: unknown } | undefined)?.mcp_app
      return (
        <div>
          <ToolCall
            name={block.toolName || ''}
            args={block.toolArgs}
            done={block.toolDone}
            liveOutput={block.toolOutput}
            result={block.toolResult}
            resultBytes={block.toolResultBytes}
            scriptRun={block.toolScriptRun}
            argsBytes={block.toolArgsBytes}
            durationMs={block.durationMs}
            startedAt={block.startedAt}
            toolCallId={block.toolCallId}
          />
          {block.toolDone && Boolean(mcpApp) && latestMCPAppBlockIds?.has(block.id) ? (
            <div className="mt-2">
              <MCPAppResult mcpApp={mcpApp as never} sessionId={sessionId} toolCallId={block.toolCallId} />
            </div>
          ) : null}
        </div>
      )
    }
    case 'text': {
      // Me sleep sentinel — show any preceding content normally, then append idle pill
      const sleepPrefix = extractSleepPrefix(block.content)
      if (sleepPrefix !== null) {
        return (
          <div>
            {sleepPrefix && <MarkdownBlock content={sleepPrefix} sessionId={sessionId} />}
            <div className="my-3 flex items-center gap-3 text-xs text-(--color-text-muted)" role="note">
              <span aria-hidden className="h-px flex-1 bg-(--color-border)" />
              Agent idle
              <span aria-hidden className="h-px flex-1 bg-(--color-border)" />
            </div>
          </div>
        )
      }
      // An assistant message. No menu of its own: a right-click or a long
      // press selects text and opens the system's menu (Copy, Look Up); the
      // footer's Copy takes the whole answer.
      return (
        <div>
          <MarkdownBlock content={block.content} sessionId={sessionId} isStreaming={isStreaming} />
        </div>
      )
    }
    default:
      return null
  }
})

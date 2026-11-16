/**
 * Rich tool result renderers: this file picks one; each tool's renderer
 * lives in its own file beside it.
 *
 * Each renderer receives the raw `result` string emitted by the backend and
 * the `toolName` so it can pick the right display strategy. Fall back to the
 * generic text view when nothing more specific applies.
 *
 * Visual language matches the `ToolCall` aside: no opaque dark fills, no
 * boxed-in containers. Results flow under the same left-rule indentation
 * as the args. When a code-like block is needed (file contents, shell
 * output), we use a quiet `--bg-key` tint and a thin border
 * rather than an overlay. Theme-aware, no hard-coded rgba.
 */

import type { ReactNode } from 'react'
import { canonicalToolName } from '@/utils/tool-names'
import { BackgroundProcessResult } from './BackgroundProcessResult'
import { FileListResult, FileReadResult } from './FileResults'
import { GenericResult } from './GenericResult'
import { LspDiagnosticsView, parseLspDiagnostics } from './LspDiagnostics'
import { LspNavigationResult } from './LspNavigationResult'
import { ScheduleTaskListResult } from './ScheduleTaskListResult'
import { ShellResult } from './ShellResult'
import { TeamToolResult } from './TeamToolResult'
import { TodoListResult } from './TodoListResult'
import { WebSearchResult } from './WebSearchResult'

function ToolResultInner({ toolName: rawName, operation, result, headerAction, onCollapse }: { toolName: string; operation?: string; result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  const toolName = canonicalToolName(rawName)
  if (toolName === 'lsp') {
    return <LspNavigationResult operation={operation} result={result} />
  }
  if (toolName === 'web_search') {
    return <WebSearchResult result={result} />
  }
  if (toolName === 'bg') {
    return <BackgroundProcessResult result={result} headerAction={headerAction} onCollapse={onCollapse} />
  }
  if (toolName === 'schedule') {
    return <ScheduleTaskListResult result={result} />
  }
  if (toolName === 'shell') {
    return <ShellResult result={result} />
  }
  if (toolName === 'glob' || toolName === 'grep') {
    return <FileListResult result={result} />
  }
  if (toolName === 'read') {
    return <FileReadResult result={result} />
  }
  if (toolName === 'todo') {
    return <TodoListResult result={result} />
  }
  if (toolName === 'team') {
    return <TeamToolResult result={result} />
  }
  // web_fetch, date, math, skill, etc.
  return <GenericResult result={result} />
}

export function ToolResult({ toolName, operation, result, headerAction, onCollapse }: { toolName: string; operation?: string; result: string; headerAction?: ReactNode; onCollapse?: () => void }) {
  const lspData = parseLspDiagnostics(result)

  if (lspData) {
    return (
      <div className="flex flex-col gap-1">
        <ToolResultInner toolName={toolName} operation={operation} result={lspData.cleanText} headerAction={headerAction} onCollapse={onCollapse} />
        <LspDiagnosticsView diagnostics={lspData.diagnostics} overflowCount={lspData.overflowCount} />
      </div>
    )
  }

  return <ToolResultInner toolName={toolName} operation={operation} result={result} headerAction={headerAction} onCollapse={onCollapse} />
}

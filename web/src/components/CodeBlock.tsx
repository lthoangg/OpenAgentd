import { TerminalSquare } from 'lucide-react'

import { isShellLanguage, requestTerminalRun, useTerminalRunAvailable } from '@/lib/terminal-run'
import { COPY_BUTTON_CLASS, CopyButton } from './ToolCall/CopyButton'

interface CodeBlockProps {
  children: React.ReactNode
  language?: string
  rawText: string
  noHeader?: boolean
  /** False while the block is still being written: a half command must not run. */
  runnable?: boolean
}

const RUN_LABEL = 'Run in terminal'

/**
 * Runs a shell block's command in the workspace's terminal (the Review dock
 * shows it). Only where a terminal exists, so it renders nothing otherwise.
 */
function RunInTerminalButton({ command }: { command: string }) {
  const available = useTerminalRunAvailable()
  if (!available || command.trim() === '') return null
  return (
    <button
      type="button"
      aria-label={RUN_LABEL}
      title={RUN_LABEL}
      onClick={(event) => {
        event.stopPropagation()
        requestTerminalRun(command)
      }}
      className={COPY_BUTTON_CLASS}
    >
      <TerminalSquare size={12} aria-hidden />
    </button>
  )
}

export function CodeBlock({ children, language, rawText, noHeader = false, runnable = true }: CodeBlockProps) {
  if (noHeader) {
    return (
      <pre className="overflow-auto px-3 py-2.5 font-mono text-code leading-relaxed text-(--color-text)">
        <code>{children}</code>
      </pre>
    )
  }

  return (
    <div
      data-slot="code-block"
      className="relative my-1.5 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-input)"
    >
      {/* Every block has a header with Copy at rest (muted), the same
          control the tool sections use; a bare fence is captioned "text". */}
      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3">
        <span className="font-mono label-caps text-(--color-text-muted)">
          {language || 'text'}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {runnable && isShellLanguage(language) && <RunInTerminalButton command={rawText} />}
          <CopyButton label="Copy code" text={rawText} />
        </span>
      </div>
      <pre className="overflow-auto px-3 py-2.5 font-mono text-code leading-relaxed text-(--color-text)">
        <code>{children}</code>
      </pre>
    </div>
  )
}

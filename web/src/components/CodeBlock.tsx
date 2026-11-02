import { copyText, useChatMenu } from './ChatContextMenu'
import { CopyButton } from './ToolCall/CopyButton'

interface CodeBlockProps {
  children: React.ReactNode
  language?: string
  rawText: string
  noHeader?: boolean
}

export function CodeBlock({ children, language, rawText, noHeader = false }: CodeBlockProps) {
  const chatMenu = useChatMenu(language ? `Actions for ${language} code` : 'Actions for code', () => [
    { label: 'Copy code', run: () => copyText(rawText) },
  ])

  if (noHeader) {
    return (
      <pre onContextMenu={chatMenu.onContextMenu} onKeyDown={chatMenu.onKeyDown} className="overflow-auto px-3 py-2.5 font-mono text-code leading-relaxed text-(--color-text)">
        <code>{children}</code>
        {chatMenu.menu}
      </pre>
    )
  }

  return (
    <div
      onContextMenu={chatMenu.onContextMenu}
      onKeyDown={chatMenu.onKeyDown}
      data-slot="code-block"
      className="relative my-1.5 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-input)"
    >
      {/* Every block has a header with Copy at rest (muted), the same
          control the tool sections use; a bare fence is captioned "text". */}
      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3">
        <span className="font-mono label-caps text-(--color-text-muted)">
          {language || 'text'}
        </span>
        <CopyButton label="Copy code" text={rawText} />
      </div>
      <pre className="overflow-auto px-3 py-2.5 font-mono text-code leading-relaxed text-(--color-text)">
        <code>{children}</code>
      </pre>
      {chatMenu.menu}
    </div>
  )
}

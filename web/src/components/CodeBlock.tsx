import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText, useChatMenu } from './ChatContextMenu'

interface CodeBlockProps {
  children: React.ReactNode
  language?: string
  rawText: string
  noHeader?: boolean
}

export function CodeBlock({ children, language, rawText, noHeader = false }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const chatMenu = useChatMenu(language ? `Actions for ${language} code` : 'Actions for code', () => [
    { label: 'Copy code', run: () => copyText(rawText) },
  ])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access is best-effort.
    }
  }

  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-7 w-7 items-center justify-center rounded-md text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-6 md:w-6 md:rounded-xs md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
            aria-label="Copy code"
          >
            {copied ? (
              <Check size={13} className="text-(--color-success)" />
            ) : (
              <Copy size={13} />
            )}
          </button>
        }
      />
      <TooltipContent>Copy</TooltipContent>
    </Tooltip>
  )

  if (noHeader) {
    return (
      <pre onContextMenu={chatMenu.onContextMenu} onKeyDown={chatMenu.onKeyDown} className="overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-(--color-text)">
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
      className="group relative my-1.5 overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)"
    >
      {language ? (
        <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3">
          <span className="font-mono label-caps text-(--color-text-muted)">
            {language}
          </span>
          {copyButton}
        </div>
      ) : (
        <div className="absolute top-1.5 right-1.5 z-10">{copyButton}</div>
      )}
      <pre className="overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-(--color-text)">
        <code>{children}</code>
      </pre>
      {chatMenu.menu}
    </div>
  )
}

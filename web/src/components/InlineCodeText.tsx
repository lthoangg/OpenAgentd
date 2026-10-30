/**
 * Plain text with its `code` spans set in mono, as the author wrote them.
 * For short prose fields (a goal's objective, a check's reason) that are not
 * worth a markdown render.
 */
import type { ReactNode } from 'react'

export function InlineCodeText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g)
  const out: ReactNode[] = parts.map((part, i) => (
    part.length > 2 && part.startsWith('`') && part.endsWith('`')
      ? <code key={i} className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 font-mono text-[0.85em] text-(--color-text) [box-decoration-break:clone]">{part.slice(1, -1)}</code>
      : part
  ))
  return <>{out}</>
}

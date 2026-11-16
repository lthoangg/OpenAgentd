/**
 * The result of a tool with no renderer of its own: JSON pretty-printed,
 * anything else as text, with file paths made openable. Other results fall
 * back to it when their output is not the shape they expect.
 */

import { LinkifiedText } from '../FileRefLink'
import { truncateForDisplay } from '../ToolCall/displayText'

/** The parsed JSON value, or ``null`` when ``raw`` is not JSON. */
export function tryParseJSON(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function GenericResult({ result }: { result: string }) {
  // Try pretty-print if JSON
  const parsed = tryParseJSON(result)
  const display =
    parsed !== null && typeof parsed === 'object'
      ? JSON.stringify(parsed, null, 2)
      : result
  const clipped = truncateForDisplay(display)

  return (
    <pre className="max-h-[calc(8*1.55em)] sm:max-h-[calc(10*1.55em)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-(--color-text-2)">
      <LinkifiedText text={clipped} />
    </pre>
  )
}

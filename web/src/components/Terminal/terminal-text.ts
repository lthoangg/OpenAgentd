/**
 * The terminal's scrollback as plain lines, for the Select Text view.
 *
 * xterm.js selects only with a mouse: on touch a drag scrolls, so a phone
 * could select everything or nothing. The view shows these lines as ordinary
 * text instead, where the platform's own selection (handles, magnifier, word
 * snapping) works. Pure: it reads a structural slice of xterm's buffer, so it
 * is testable without the renderer.
 */

export interface TextBufferLine {
  /** This row continues the row above it (the shell's line was too long). */
  isWrapped: boolean
  translateToString: (trimRight?: boolean) => string
}

export interface TextBuffer {
  length: number
  /** The first row on screen. */
  viewportY: number
  getLine: (y: number) => TextBufferLine | undefined
}

export interface TerminalText {
  lines: string[]
  /** The line holding the first row on screen, so the view opens there. */
  viewportLine: number
}

/**
 * Rows joined into the lines the program printed (a wrapped row continues
 * the line above it, so copying it adds no line break), trailing spaces and
 * trailing blank lines dropped.
 */
export function terminalBufferText(buffer: TextBuffer): TerminalText {
  const lines: string[] = []
  let viewportLine = 0
  for (let y = 0; y < buffer.length; y++) {
    const row = buffer.getLine(y)
    if (!row) continue
    // Untrimmed: a space at the wrap column belongs to the joined line.
    const text = row.translateToString(false)
    if (row.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
    if (y === buffer.viewportY) viewportLine = lines.length - 1
  }
  const trimmed = lines.map((line) => line.replace(/\s+$/, ''))
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return { lines: trimmed, viewportLine: Math.min(viewportLine, Math.max(0, trimmed.length - 1)) }
}

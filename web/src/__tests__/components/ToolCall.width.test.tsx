/**
 * An open tool row's details stay in the text column, as code blocks, tables
 * and diagrams do: nothing in the transcript widens past it, and no column
 * width is pushed to CSS while the chat resizes (that cost a style pass over
 * the whole transcript on every frame of a sidebar or panel slide).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ToolCall } from '@/components/ToolCall'

afterEach(cleanup)

describe('an open tool row', () => {
  it('keeps its details at the column width', () => {
    const { container } = render(
      <ToolCall name="custom_tool" args={JSON.stringify({ query: 'a long argument' })} done result="some result" />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Expand custom_tool details/ }))

    expect(screen.getByText('some result')).toBeTruthy()
    expect(container.querySelector('[data-breakout]')).toBeNull()
  })

  it('has no transcript rule that widens anything past the column', () => {
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
    expect(css).not.toContain('--oa-breakout')
    expect(css).not.toContain('--oa-transcript-w')
  })
})

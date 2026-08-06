/**
 * InlineMarkdown — soft inline formatting for agent-authored question text.
 *
 * The strings come from a model and are rendered inside a card the user is
 * about to act on, so this renderer is deliberately narrow:
 *
 * - inline code, bold and italic only — no blocks, no headings, no lists
 * - **link syntax is never turned into an anchor**: a clickable URL the model
 *   chose, inside a prompt the user is being asked to trust, is a phishing
 *   surface. It stays visible as literal text so the user sees exactly what
 *   was written.
 * - ``variant="code"`` narrows it further to inline code only, for option
 *   labels where bold/italic would just be noise.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import '@testing-library/jest-dom'
import { render, screen, cleanup } from '@testing-library/react'
import { InlineMarkdown } from '@/utils/inline-markdown'

afterEach(cleanup)

describe('InlineMarkdown', () => {
  it('renders inline code as a code element', () => {
    render(<InlineMarkdown text="Run `bun test` first" />)

    const code = screen.getByText('bun test')
    expect(code.tagName).toBe('CODE')
  })

  it('renders bold and italic', () => {
    const { container } = render(<InlineMarkdown text="**must** be *fast*" />)

    expect(container.querySelector('strong')?.textContent).toBe('must')
    expect(container.querySelector('em')?.textContent).toBe('fast')
  })

  it('leaves link syntax as literal text and renders no anchor', () => {
    const { container } = render(
      <InlineMarkdown text="see [the docs](https://evil.example/login)" />,
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('see [the docs](https://evil.example/login)')
  })

  it('does not render a bare URL as an anchor', () => {
    const { container } = render(<InlineMarkdown text="go to https://evil.example" />)

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('go to https://evil.example')
  })

  it('renders html as text rather than markup', () => {
    const { container } = render(
      <InlineMarkdown text="<img src=x onerror=alert(1)> and <b>hi</b>" />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> and <b>hi</b>')
  })

  it('keeps bold and italic literal in the code-only variant', () => {
    const { container } = render(
      <InlineMarkdown text="**keep** `--flag` *plain*" variant="code" />,
    )

    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('em')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('--flag')
    expect(container.textContent).toBe('**keep** --flag *plain*')
  })

  it('leaves an unterminated marker as literal text', () => {
    const { container } = render(<InlineMarkdown text="a `broken and **also" />)

    expect(container.querySelector('code')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toBe('a `broken and **also')
  })

  it('does not treat bold markers as italic markers', () => {
    const { container } = render(<InlineMarkdown text="**bold**" />)

    expect(container.querySelector('em')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('bold')
  })

  it('renders plain text unchanged', () => {
    const { container } = render(<InlineMarkdown text="Which package manager?" />)

    expect(container.textContent).toBe('Which package manager?')
  })

  it('renders nothing for empty text', () => {
    const { container } = render(<InlineMarkdown text="" />)

    expect(container.textContent).toBe('')
  })

  it('does not treat an intra-word underscore as italic', () => {
    const { container } = render(<InlineMarkdown text="use snake_case_names here" />)

    expect(container.querySelector('em')).toBeNull()
    expect(container.textContent).toBe('use snake_case_names here')
  })
})

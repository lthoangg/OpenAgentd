import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { Input } from '@/components/ui/input'
import { SearchBar } from '@/components/ui/search-bar'
import { InlineTitleInput } from '@/components/ui/inline-title-input'

afterEach(cleanup)

describe('Input iOS text defaults', () => {
  it('turns autocapitalize and autocorrect off by default', () => {
    render(<Input aria-label="plain" />)
    const el = screen.getByLabelText('plain')
    expect(el.getAttribute('autocapitalize')).toBe('off')
    expect(el.getAttribute('autocorrect')).toBe('off')
  })

  it('lets callers opt prose fields back in', () => {
    render(<Input aria-label="prose" autoCapitalize="sentences" autoCorrect="on" />)
    const el = screen.getByLabelText('prose')
    expect(el.getAttribute('autocapitalize')).toBe('sentences')
    expect(el.getAttribute('autocorrect')).toBe('on')
  })
})

describe('enterKeyHint', () => {
  it('SearchBar shows a search key', () => {
    render(<SearchBar placeholder="Find" />)
    expect(screen.getByPlaceholderText('Find').getAttribute('enterkeyhint')).toBe('search')
  })

  it('InlineTitleInput shows a done key', () => {
    render(<InlineTitleInput initial="Title" label="Rename" onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText('Rename').getAttribute('enterkeyhint')).toBe('done')
  })
})

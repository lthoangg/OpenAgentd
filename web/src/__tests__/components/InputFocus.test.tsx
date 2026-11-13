import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SearchBar } from '@/components/ui/search-bar'

afterEach(cleanup)

describe('Input focus border suppression', () => {
  it('Input component has focus outline suppression classes', () => {
    render(<Input placeholder="test input" />)
    const el = screen.getByPlaceholderText('test input')
    expect(el.className).toContain('focus:outline-none')
    expect(el.className).toContain('focus-visible:outline-none')
  })

  it('Textarea component has focus outline suppression classes', () => {
    render(<Textarea placeholder="test textarea" />)
    const el = screen.getByPlaceholderText('test textarea')
    expect(el.className).toContain('focus:outline-none')
    expect(el.className).toContain('focus-visible:outline-none')
  })

  it('SearchBar inner input has border and outline suppression classes', () => {
    render(<SearchBar placeholder="search something" />)
    const el = screen.getByPlaceholderText('search something')
    expect(el.className).toContain('focus:outline-none')
    expect(el.className).toContain('focus-visible:outline-none')
    expect(el.className).toContain('border-none')
  })
})

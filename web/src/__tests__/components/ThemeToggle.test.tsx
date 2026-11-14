import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeToggle } from '@/components/ThemeToggle'
import { THEME_STORAGE_KEY } from '@/lib/theme'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark', 'light')
})

describe('ThemeToggle', () => {
  it('defaults to system preference with no stored value', () => {
    render(<ThemeToggle />)
    const systemRadio = screen.getByRole('radio', { name: 'System' })
    expect(systemRadio.getAttribute('aria-checked')).toBe('true')
  })

  it('reflects stored preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    render(<ThemeToggle />)
    const lightRadio = screen.getByRole('radio', { name: 'Light' })
    expect(lightRadio.getAttribute('aria-checked')).toBe('true')
  })

  it('updates preference on click and applies class', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)

    await user.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
  })

  it('exposes all three options as radios in radiogroup', () => {
    render(<ThemeToggle />)
    const group = screen.getByRole('radiogroup', { name: 'Theme preference' })
    expect(group).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  describe('collapsed variant', () => {
    it('renders a single button instead of the radio group', () => {
      render(<ThemeToggle collapsed />)
      expect(screen.queryByRole('radiogroup')).toBeNull()
      expect(screen.getAllByRole('button')).toHaveLength(1)
    })

    it('cycles system -> light -> dark -> system on click', async () => {
      const user = userEvent.setup()
      render(<ThemeToggle collapsed />)

      const button = screen.getByRole('button')

      // starts as system
      expect(button.getAttribute('aria-label')).toContain('System')

      await user.click(button)
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

      await user.click(button)
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

      await user.click(button)
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    })

    it('names the theme and the one a press switches to, with no pointer verb', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light')
      render(<ThemeToggle collapsed />)
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Theme: Light. Switch to Dark.')
    })
  })
})

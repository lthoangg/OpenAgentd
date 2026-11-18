import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

import { ConnectorIcon, monogram } from '@/components/ConnectorIcon'

afterEach(cleanup)

describe('ConnectorIcon', () => {
  it('draws the logo as an inline path, hidden from screen readers', () => {
    const { container } = render(<ConnectorIcon name="Neon" icon={{ path: 'M24 0V24H0V0Z', view_box: '0 0 24 24' }} />)
    const well = container.firstElementChild!
    expect(well.getAttribute('aria-hidden')).toBe('true')
    expect(well.getAttribute('data-connector-icon')).toBe('logo')
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(container.querySelector('path')?.getAttribute('d')).toBe('M24 0V24H0V0Z')
    expect(well.textContent).toBe('')
  })

  it('falls back to the monogram without a logo', () => {
    const { container } = render(<ConnectorIcon name="Exa Search" icon={null} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.firstElementChild!.getAttribute('data-connector-icon')).toBe('monogram')
    expect(container.textContent).toBe('ES')
  })

  it('makes a monogram from any name', () => {
    expect(monogram('Context7')).toBe('CO')
    expect(monogram('my-tools')).toBe('MT')
    expect(monogram('changelog-tools/github')).toBe('CT')
    expect(monogram('---')).toBe('?')
  })
})

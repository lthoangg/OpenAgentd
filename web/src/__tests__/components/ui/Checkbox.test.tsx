import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

afterEach(cleanup)

describe('Checkbox', () => {
  it('draws its tick as a dashed polyline, not a lucide icon that pops in', () => {
    render(<Checkbox aria-label="Agree" />)
    const polyline = document.querySelector('svg[data-slot="checkbox-check"] polyline')!
    expect(polyline).toBeTruthy()
    expect(polyline.getAttribute('class')).toContain('[stroke-dasharray:13]')
    expect(polyline.getAttribute('class')).toContain('[stroke-dashoffset:13]')
    // CSS only: the checked look hangs on the input's :checked via peer-*.
    const svg = document.querySelector('svg[data-slot="checkbox-check"]')!
    expect(svg.getAttribute('class')).toContain('peer-checked:[&>polyline]:[stroke-dashoffset:0]')
    expect(svg.getAttribute('class')).not.toContain('hidden')
  })

  it('draws at base with a beat when checked and undraws at fast', () => {
    render(<Checkbox aria-label="Agree" />)
    const svg = document.querySelector('svg[data-slot="checkbox-check"]')!.getAttribute('class')!
    const polyline = document.querySelector('polyline')!.getAttribute('class')!
    expect(svg).toContain('peer-checked:[&>polyline]:delay-60')
    expect(svg).toContain('peer-checked:[&>polyline]:duration-(--motion-base)')
    expect(polyline).toContain('duration-(--motion-fast)')
  })

  it('dips under the press at instant and crossfades the fill at fast', () => {
    render(<Checkbox aria-label="Agree" />)
    const box = screen.getByRole('checkbox').className
    expect(box).toContain('enabled:active:scale-90')
    expect(box).toContain('transition-[background-color,border-color,scale]')
    expect(box).toContain('var(--motion-instant)')
  })

  it('reports the next checked state and keeps checkClassName', () => {
    const onCheckedChange = mock(() => {})
    render(<Checkbox aria-label="Agree" onCheckedChange={onCheckedChange} checkClassName="text-red-500" />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
    expect(document.querySelector('svg[data-slot="checkbox-check"]')!.getAttribute('class')).toContain('text-red-500')
  })
})

describe('RadioGroupItem', () => {
  it('scales its dot up from 50% with the soft spring while it fades in', () => {
    render(
      <RadioGroup defaultValue="a">
        <RadioGroupItem value="a" aria-label="A" />
      </RadioGroup>,
    )
    const dot = document.querySelector('[data-slot="radio-group-dot"]')!.getAttribute('class')!
    expect(dot).toContain('scale-50')
    expect(dot).toContain('peer-checked:scale-100')
    expect(dot).toContain('peer-checked:opacity-100')
    expect(dot).toContain('transition-[opacity,scale]')
    expect(dot).toContain('duration-(--motion-fast)')
    expect(dot).toContain('ease-(--ease-spring-soft)')
  })
})

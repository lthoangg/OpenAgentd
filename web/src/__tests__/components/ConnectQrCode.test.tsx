import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { LOGO } from '@/lib/brand/logo-data'

/** A 33-module matrix (25 + the 4-module quiet zone on each side), all dark. */
const N = 33
const options: unknown[] = []
mock.module('uqr', () => ({
  encode: (_value: string, opts: unknown) => {
    options.push(opts)
    return { data: Array.from({ length: N }, () => Array.from({ length: N }, () => true)) }
  },
}))

const { ConnectQrCode, layoutQr } = await import('@/components/ConnectQrCode')

afterEach(() => {
  cleanup()
  options.length = 0
})

function darkModules(path: string): Array<[number, number]> {
  return [...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])])
}

describe('layoutQr', () => {
  it('centres an odd-sized logo box and leaves it and a one-module margin empty', () => {
    const data = Array.from({ length: N }, () => Array.from({ length: N }, () => true))
    const { size, path, logo } = layoutQr(data)
    expect(size).toBe(N)
    // 22% of the 25-module code (5.5 → 6), down to an odd count so it centres on the grid.
    expect(logo).toEqual({ x: 14, size: 5 })
    const cleared = (v: number) => v >= 13 && v <= 19
    const dark = darkModules(path)
    expect(dark.some(([x, y]) => cleared(x) && cleared(y))).toBe(false)
    expect(dark.length).toBe(N * N - 7 * 7)
  })

  it('draws no logo on a matrix too small to hold one', () => {
    expect(layoutQr([[true, false], [false, true]]).logo).toBeNull()
  })
})

describe('ConnectQrCode', () => {
  it('encodes with ecc Q and draws the seal in the middle', async () => {
    const { container } = render(<ConnectQrCode value="openagentd://connect?key=k" />)
    expect(await screen.findByRole('img', { name: 'Connection QR code' })).toBeTruthy()
    expect(options[0]).toEqual({ ecc: 'Q', border: 4 })
    const seal = container.querySelector('[data-logo="seal"]')
    expect(seal?.querySelector('path')?.getAttribute('d')).toBe(LOGO.seal.disc)
    expect(seal?.querySelector('circle')?.getAttribute('r')).toBe(String(LOGO.seal.dot.r))
  })
})

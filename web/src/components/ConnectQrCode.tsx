/**
 * ConnectQrCode — renders a value as a QR code SVG. The encoder is loaded on
 * demand so it stays out of the startup bundle. The OpenAgentd seal sits in
 * the middle: the modules under it are left out, and ecc Q (25% recovery)
 * restores them when scanned.
 *
 * Colors are fixed black-on-white rather than theme tokens: phone cameras
 * need that contrast (and the light quiet zone) to read the code, including
 * in the dark theme. The seal uses the same fixed ink and light-theme Signal
 * Blue, so it looks the same in both themes.
 */
import { useEffect, useState } from 'react'
import { LOGO } from '@/lib/brand/logo-data'

interface ConnectQrCodeProps {
  value: string
  /** Rendered width and height in CSS pixels. */
  size?: number
  label?: string
}

/** Light modules around the code, in modules. */
const BORDER = 4
/** The seal's width as a share of the code (quiet zone excluded). */
const LOGO_SHARE = 0.22
/** Below this many modules the seal is unreadable; draw none. */
const MIN_LOGO_MODULES = 5
const SIGNAL_BLUE = '#5AA8E2'

export interface QrLayout {
  size: number
  path: string
  /** The seal's square: top-left module (x = y) and width, or null for none. */
  logo: { x: number; size: number } | null
}

/** Dark modules as one path, with the centre cleared for the seal. */
export function layoutQr(data: boolean[][]): QrLayout {
  const size = data.length
  let logoSize = Math.round((size - 2 * BORDER) * LOGO_SHARE)
  // Odd, so the box centres on the (odd-sized) module grid; rounding down
  // keeps it inside the recovery budget.
  if (logoSize % 2 === 0) logoSize -= 1
  const logo = logoSize >= MIN_LOGO_MODULES ? { x: (size - logoSize) / 2, size: logoSize } : null
  // One empty module around the seal keeps its edge off the code's modules.
  const cleared = (v: number) => logo !== null && v >= logo.x - 1 && v <= logo.x + logo.size
  let path = ''
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark && !(cleared(x) && cleared(y))) path += `M${x} ${y}h1v1h-1z`
    })
  })
  return { size, path, logo }
}

export function ConnectQrCode({ value, size = 200, label = 'Connection QR code' }: ConnectQrCodeProps) {
  const [matrix, setMatrix] = useState<QrLayout | null>(null)

  useEffect(() => {
    let cancelled = false
    setMatrix(null)
    void import('uqr').then(({ encode }) => {
      if (cancelled) return
      const { data } = encode(value, { ecc: 'Q', border: BORDER })
      setMatrix(layoutQr(data))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [value])

  if (!matrix) {
    return <div className="rounded-xs bg-white" style={{ width: size, height: size }} aria-hidden="true" />
  }

  const { seal } = LOGO
  const { logo } = matrix
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      className="rounded-xs"
    >
      <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
      <path d={matrix.path} fill="#000000" shapeRendering="crispEdges" />
      {logo ? (
        <g data-logo="seal" transform={`translate(${logo.x} ${logo.x}) scale(${logo.size / seal.grid})`}>
          <path fillRule="evenodd" d={seal.disc} fill="#000000" />
          <circle cx={seal.dot.cx} cy={seal.dot.cy} r={seal.dot.r} fill={SIGNAL_BLUE} />
        </g>
      ) : null}
    </svg>
  )
}

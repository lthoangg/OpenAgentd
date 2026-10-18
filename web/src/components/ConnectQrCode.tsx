/**
 * ConnectQrCode — renders a value as a QR code SVG. The encoder is loaded on
 * demand so it stays out of the startup bundle.
 *
 * Colors are fixed black-on-white rather than theme tokens: phone cameras
 * need that contrast (and the light quiet zone) to read the code, including
 * in the dark theme.
 */
import { useEffect, useState } from 'react'

interface ConnectQrCodeProps {
  value: string
  /** Rendered width and height in CSS pixels. */
  size?: number
  label?: string
}

interface Matrix {
  size: number
  path: string
}

function toPath(data: boolean[][]): string {
  let path = ''
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`
    })
  })
  return path
}

export function ConnectQrCode({ value, size = 200, label = 'Connection QR code' }: ConnectQrCodeProps) {
  const [matrix, setMatrix] = useState<Matrix | null>(null)

  useEffect(() => {
    let cancelled = false
    setMatrix(null)
    void import('uqr').then(({ encode }) => {
      if (cancelled) return
      const { data } = encode(value, { ecc: 'M', border: 4 })
      setMatrix({ size: data.length, path: toPath(data) })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [value])

  if (!matrix) {
    return <div className="rounded-xs bg-white" style={{ width: size, height: size }} aria-hidden="true" />
  }

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      shapeRendering="crispEdges"
      className="rounded-xs"
    >
      <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
      <path d={matrix.path} fill="#000000" />
    </svg>
  )
}

/** Viewport presets for the Browser tab's device frame. */

export interface DevicePreset {
  id: 'responsive' | 'mobile' | 'tablet' | 'desktop'
  label: string
  /** ``null`` fills the dock. */
  width: number | null
  height: number | null
}

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: 'responsive', label: 'Responsive', width: null, height: null },
  { id: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
]

export function devicePreset(id: string): DevicePreset {
  return DEVICE_PRESETS.find((p) => p.id === id) ?? DEVICE_PRESETS[0]
}

/** The frame size for ``preset``, swapped when ``rotated``. */
export function frameSize(preset: DevicePreset, rotated: boolean): { width: number; height: number } | null {
  if (preset.width === null || preset.height === null) return null
  return rotated ? { width: preset.height, height: preset.width } : { width: preset.width, height: preset.height }
}

/** Scale that fits ``size`` inside the available box, never enlarging. */
export function fitScale(size: { width: number; height: number } | null, available: { width: number; height: number }): number {
  if (!size || available.width <= 0 || available.height <= 0) return 1
  return Math.min(1, available.width / size.width, available.height / size.height)
}

/** "Mobile 390×844", or "Responsive 812×640" for the fill mode. */
export function deviceLabel(preset: DevicePreset, size: { width: number; height: number } | null, fallback: { width: number; height: number }): string {
  const s = size ?? fallback
  return `${preset.label} ${Math.round(s.width)}×${Math.round(s.height)}`
}

/** "390 × 844 · 62%": a framed page's real size and the scale it is drawn at (left out at full size). */
export function frameCaption(size: { width: number; height: number }, scale: number): string {
  const text = `${Math.round(size.width)} × ${Math.round(size.height)}`
  const percent = Math.round(scale * 100)
  return percent < 100 ? `${text} · ${percent}%` : text
}
